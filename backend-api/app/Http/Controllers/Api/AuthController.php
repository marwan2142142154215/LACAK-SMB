<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Responses\ApiResponse;
use App\Models\User;
use App\Models\WorkSession;
use App\Services\AccountCenter;
use App\Services\LiveKitTokenIssuer;
use App\Services\WorkPresence;
use App\Support\TwoFactorPolicy;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;
use PragmaRX\Google2FAQRCode\Google2FA;

/**
 * Alur login:
 *  1. POST /auth/login (username ATAU email Account Center, password)
 *     - belum pernah setup 2FA  -> balas requires_2fa_setup + qr_code_svg + setup_token
 *     - sudah setup 2FA          -> balas requires_2fa + challenge_token
 *  2. POST /auth/2fa/setup/confirm (setup_token, code) -> aktifkan 2FA, keluarkan token akses
 *  3. POST /auth/2fa/verify (challenge_token, code)    -> keluarkan token akses
 *
 * Dipakai bersama oleh web dashboard, APK master, dan jembatan bot Telegram —
 * ketiganya wajib login lewat endpoint yang sama ini (tidak ada jalur pintas).
 */
class AuthController extends Controller
{
    use ApiResponse;

    private const SETUP_TTL_MINUTES = 10;

    private const CHALLENGE_TTL_MINUTES = 5;

    /**
     * Toleransi waktu TOTP: ±2 periode (±60 detik) supaya jam authenticator
     * yang sedikit meleset tidak membuat kode selalu ditolak.
     */
    private const OTP_WINDOW = 2;

    /** Maksimum percobaan kode salah per challenge sebelum sesi login dibatalkan. */
    private const MAX_2FA_ATTEMPTS = 5;

    // Standar keamanan perusahaan (bagian 6.4): "token dan sesi memiliki
    // masa berlaku, tidak berlaku selamanya" -- diterapkan sebagai sesi
    // IDLE TIMEOUT (seperti sesi login biasa), bukan batas absolut dari
    // waktu login: tiap request yang diautentikasi memperpanjang expires_at
    // 2 jam ke depan lagi (lihat middleware ExtendTokenExpiry di
    // bootstrap/app.php), jadi staf yang aktif terus tidak pernah ke-logout
    // paksa, tapi yang diam/menutup tab 2 jam otomatis perlu login ulang.
    //
    // SENGAJA per-token lewat createToken($name, $abilities, $expiresAt),
    // BUKAN lewat config('sanctum.expiration') global -- itu akan ikut
    // memotong token akun layanan (telegram-bot, dkk, lihat
    // App\Console\Commands\IssueTelegramBotToken) yang memang harus hidup
    // terus tanpa ada yang login ulang untuk memperbaruinya. Token service
    // account dibuat TANPA expires_at (null) dan ExtendTokenExpiry sengaja
    // membiarkan token null tetap null, tidak pernah memberinya expiry.
    public const TOKEN_IDLE_HOURS = 2;

    /** Penanda token yang dicabut karena akunnya login di perangkat lain. */
    public const REPLACED_TOKEN_CACHE_PREFIX = 'auth:replaced_token:';

    public function login(Request $request)
    {
        $credentials = $request->validate([
            'username' => ['required', 'string'],
            'password' => ['required', 'string'],
            'client' => ['nullable', 'string', 'in:web_dashboard,master_app,telegram_bot'],
        ]);

        $identifier = trim($credentials['username']);

        // Email + Account Center terpasang -> password diverifikasi Account
        // Center, BUKAN password lokal. Username biasa (akun layanan seperti
        // bot Telegram) tetap memakai password lokal. Dua-duanya lalu lewat
        // 2FA, kecuali super_admin mematikannya (lihat TwoFactorPolicy).
        if (str_contains($identifier, '@') && AccountCenter::isConfigured()) {
            $outcome = AccountCenter::login(mb_strtolower($identifier), $credentials['password']);

            if ($outcome['state'] === AccountCenter::UNAVAILABLE) {
                return $this->fail('Layanan Account Center sedang tidak dapat dihubungi. Coba lagi beberapa saat lagi.', null, 503);
            }

            if ($outcome['state'] !== AccountCenter::AUTHENTICATED) {
                return $this->fail('Email atau password salah', null, 401);
            }

            // Account Center hanya membuktikan identitas -- akun, role, dan
            // site tetap harus sudah dibuat admin di sini (tidak dibuat otomatis).
            $user = User::whereRaw('LOWER(email) = ?', [$outcome['email']])->first();

            if (! $user) {
                return $this->fail('Akun Account Center Anda belum terdaftar di Lacak SMB. Hubungi super admin.', null, 403);
            }
        } else {
            // Tidak peka huruf besar/kecil: keyboard HP sering mengapitalkan huruf pertama.
            $user = User::whereRaw('LOWER(username) = ?', [mb_strtolower($identifier)])->first();

            if (! $user || ! Hash::check($credentials['password'], $user->password)) {
                return $this->fail('Username atau password salah', null, 401);
            }
        }

        if (! $user->is_active) {
            return $this->fail('Akun Anda dinonaktifkan. Hubungi super admin.', null, 403);
        }

        // 2FA berlaku untuk SEMUA akun tanpa pengecualian -- kecuali
        // super_admin mematikannya untuk seluruh sistem (mis. server uji).
        if (! TwoFactorPolicy::isRequired()) {
            $token = $this->issueLoginToken($user, $request);

            return $this->success('Login berhasil', [
                'access_token' => $token,
                'token_type' => 'Bearer',
                'user' => $this->userPayload($user),
            ]);
        }

        if (! $user->hasConfirmedTwoFactor()) {
            return $this->beginTwoFactorSetup($user);
        }

        $challengeToken = Str::random(48);
        Cache::put("auth:2fa_challenge:{$challengeToken}", $user->id, now()->addMinutes(self::CHALLENGE_TTL_MINUTES));

        return $this->success('Masukkan kode 2FA dari aplikasi authenticator Anda', [
            'requires_2fa' => true,
            'challenge_token' => $challengeToken,
            'expires_in_seconds' => self::CHALLENGE_TTL_MINUTES * 60,
        ]);
    }

    private function beginTwoFactorSetup(User $user)
    {
        $google2fa = new Google2FA;
        $secret = $google2fa->generateSecretKey();

        $setupToken = Str::random(48);
        Cache::put("auth:2fa_setup:{$setupToken}", [
            'user_id' => $user->id,
            'secret' => $secret,
        ], now()->addMinutes(self::SETUP_TTL_MINUTES));

        $qrInlineSvg = $google2fa->getQRCodeInline(
            config('app.name'),
            $user->email,
            $secret
        );

        return $this->success('Scan QR ini dengan Google Authenticator / Authy, lalu konfirmasi kode 6 digit', [
            'requires_2fa_setup' => true,
            'setup_token' => $setupToken,
            'secret_manual_entry' => $secret,
            'qr_code_svg' => $qrInlineSvg,
            'expires_in_seconds' => self::SETUP_TTL_MINUTES * 60,
        ]);
    }

    public function confirmTwoFactorSetup(Request $request)
    {
        $data = $request->validate([
            'setup_token' => ['required', 'string'],
            'code' => ['required', 'digits:6'],
        ]);

        $payload = Cache::get("auth:2fa_setup:{$data['setup_token']}");

        if (! $payload) {
            return $this->fail('Sesi setup 2FA sudah kedaluwarsa, silakan login ulang', null, 410);
        }

        $google2fa = new Google2FA;

        // verifyKeyNewer dengan baseline int 1 -> kembalian int nomor window
        // (toleransi clock drift lewat OTP_WINDOW). verifyKey biasa akan
        // mengembalikan true dan window-nya tidak bisa disimpan untuk replay.
        $matchedTimestamp = $google2fa->verifyKeyNewer($payload['secret'], $data['code'], 1, self::OTP_WINDOW);

        if ($matchedTimestamp === false) {
            return $this->fail('Kode 2FA salah', null, 422);
        }

        /** @var User $user */
        $user = User::findOrFail($payload['user_id']);

        // Catat window terpakai supaya kode setup yang sama tidak bisa langsung
        // dipakai ulang di /2fa/verify (proteksi replay).
        Cache::put("auth:2fa_last_ts:{$user->id}", (int) $matchedTimestamp, now()->addMinutes(2));

        $recoveryCodes = collect(range(1, 8))
            ->map(fn () => Str::random(10))
            ->values();

        $token = DB::transaction(function () use ($user, $payload, $recoveryCodes, $request): string {
            $user->forceFill([
                'two_factor_secret' => Crypt::encryptString($payload['secret']),
                'two_factor_recovery_codes' => Crypt::encryptString($recoveryCodes->toJson()),
                'two_factor_confirmed_at' => now(),
            ])->save();

            return $this->issueLoginToken($user, $request);
        });

        Cache::forget("auth:2fa_setup:{$data['setup_token']}");

        return $this->success('2FA aktif, Anda berhasil login', [
            'access_token' => $token,
            'token_type' => 'Bearer',
            'recovery_codes' => $recoveryCodes,
            'user' => $this->userPayload($user),
        ]);
    }

    public function verifyTwoFactor(Request $request)
    {
        $data = $request->validate([
            'challenge_token' => ['required', 'string'],
            // Bukan lagi digits:6 -- boleh kode TOTP 6 digit ATAU recovery code.
            'code' => ['required', 'string', 'max:40'],
        ]);

        $challengeKey = "auth:2fa_challenge:{$data['challenge_token']}";
        $attemptsKey = "auth:2fa_attempts:{$data['challenge_token']}";

        $userId = Cache::get($challengeKey);

        if (! $userId) {
            return $this->fail('Sesi login sudah kedaluwarsa, silakan login ulang', null, 410);
        }

        // Batasi percobaan per challenge: setelah beberapa kali salah, sesi
        // login dibatalkan supaya kode tidak bisa ditebak beruntun (selain
        // throttle per-IP di route).
        if ((int) Cache::get($attemptsKey, 0) >= self::MAX_2FA_ATTEMPTS) {
            Cache::forget($challengeKey);
            Cache::forget($attemptsKey);

            return $this->fail('Terlalu banyak percobaan. Silakan login ulang.', null, 429);
        }

        /** @var User $user */
        $user = User::findOrFail($userId);

        if (! $this->consumeTwoFactorCode($user, $data['code'])) {
            Cache::put($attemptsKey, (int) Cache::get($attemptsKey, 0) + 1, now()->addMinutes(self::CHALLENGE_TTL_MINUTES));

            return $this->fail('Kode 2FA salah', null, 422);
        }

        Cache::forget($challengeKey);
        Cache::forget($attemptsKey);

        $token = $this->issueLoginToken($user, $request);

        return $this->success('Login berhasil', [
            'access_token' => $token,
            'token_type' => 'Bearer',
            'user' => $this->userPayload($user),
        ]);
    }

    /**
     * Verifikasi kode login kedua: TOTP (dengan toleransi clock drift + proteksi
     * replay) atau recovery code (dipakai sekali lalu hangus). True kalau sah.
     */
    private function consumeTwoFactorCode(User $user, string $code): bool
    {
        // Recovery code bukan 6 digit angka -> cek & konsumsi dari daftar.
        if (! preg_match('/^\d{6}$/', $code)) {
            return $user->useRecoveryCode($code);
        }

        $secret = Crypt::decryptString($user->two_factor_secret);
        $lastTsKey = "auth:2fa_last_ts:{$user->id}";

        // oldTimestamp WAJIB integer: kalau null, verifyKeyNewer mengembalikan
        // true (bukan nomor window), sehingga window terpakai tidak bisa
        // disimpan dan proteksi replay tidak pernah aktif. Baseline 1 aman
        // (jauh lebih lama dari window mana pun) untuk pemakaian pertama.
        $oldTimestamp = Cache::get($lastTsKey);
        if (! is_int($oldTimestamp)) {
            $oldTimestamp = 1;
        }

        // Hanya menerima kode valid yang window-nya lebih baru dari kode
        // terakhir -> kode yang sama tidak bisa dipakai dua kali (replay).
        $matchedTimestamp = (new Google2FA)->verifyKeyNewer(
            $secret,
            $code,
            $oldTimestamp,
            self::OTP_WINDOW
        );

        if ($matchedTimestamp === false) {
            return false;
        }

        Cache::put($lastTsKey, (int) $matchedTimestamp, now()->addMinutes(2));

        return true;
    }

    public function logout(Request $request)
    {
        $user = $request->user();

        // Logout = selesai kerja: sesi Live Kerja yang masih terbuka ditutup
        // sekarang, bukan menunggu heartbeat-nya habis.
        if ($session = WorkSession::open()->where('user_id', $user->id)->first()) {
            app(WorkPresence::class)->closeSession($session, 'logout', 'work_end');
            app(LiveKitTokenIssuer::class)->removeBroadcaster($session->organization_id, $session->user_id);
        }

        if ($user->can('live.broadcast')) {
            app(WorkPresence::class)->record($user, 'logout');
        }

        $user->currentAccessToken()->delete();

        return $this->success('Berhasil logout');
    }

    public function me(Request $request)
    {
        return $this->success('Data user saat ini', $this->userPayload($request->user()));
    }

    /**
     * Sama seperti me(), tapi route-nya tanpa extend-token: dipakai
     * realtime-gateway untuk cek ulang sesi socket dashboard tanpa ikut
     * memperpanjang idle timeout.
     */
    public function session(Request $request)
    {
        return $this->success('Sesi masih berlaku', $this->userPayload($request->user()));
    }

    /**
     * Token login + catat "Login" di log kerja (hanya akun yang bisa Live
     * Kerja -- log ini untuk jam kerja staf, bukan akun admin/bot).
     */
    private function issueLoginToken(User $user, Request $request): string
    {
        $this->endOtherSessions($user);

        $token = $user->createToken($this->tokenNameFor($request), ['*'], now()->addHours(self::TOKEN_IDLE_HOURS))->plainTextToken;

        if ($user->can('live.broadcast')) {
            app(WorkPresence::class)->record($user, 'login', WorkSession::open()->where('user_id', $user->id)->first());
        }

        return $token;
    }

    /**
     * Satu akun = satu sesi aktif: login baru mengakhiri sesi login lain akun
     * ini (web, APK Master, APK Live). Yang terbaru menang -- sesi lama yang
     * terlupa di perangkat lain tidak bisa mengunci staf keluar.
     *
     * Hanya token login (selalu punya expires_at, lihat TOKEN_IDLE_HOURS);
     * token akun layanan (expires_at null, mis. bot Telegram) tidak disentuh.
     * Id token lama diingat sebentar supaya perangkat lama diberi tahu
     * alasannya (lihat handler AuthenticationException di bootstrap/app.php).
     */
    private function endOtherSessions(User $user): void
    {
        $tokenIds = $user->tokens()->whereNotNull('expires_at')->pluck('id');

        if ($tokenIds->isEmpty()) {
            return;
        }

        foreach ($tokenIds as $tokenId) {
            Cache::put(self::REPLACED_TOKEN_CACHE_PREFIX.$tokenId, true, now()->addHours(self::TOKEN_IDLE_HOURS));
        }
        $user->tokens()->whereKey($tokenIds)->delete();

        // Siaran Live Kerja dari perangkat lama ikut diputus. Sesi kerjanya
        // tetap terbuka -- staf bisa "Lanjutkan siaran" dari perangkat baru.
        if ($session = WorkSession::open()->where('user_id', $user->id)->first()) {
            app(LiveKitTokenIssuer::class)->removeBroadcaster($session->organization_id, $session->user_id);
        }
    }

    private function tokenNameFor(Request $request): string
    {
        return $request->input('client', 'web_dashboard').'-'.now()->timestamp;
    }

    private function userPayload(User $user): array
    {
        return [
            'id' => $user->id,
            'username' => $user->username,
            'name' => $user->name,
            'email' => $user->email,
            'organization_id' => $user->organization_id,
            'roles' => $user->getRoleNames(),
            'permissions' => $user->getAllPermissions()->pluck('name'),
            // Site yang boleh dilihat role admin/leader (lihat user_site_access)
            // -- array kosong untuk role lain (super_admin/site_admin dkk tidak
            // butuh ini, scoping mereka dari organization_id atau lintas-site penuh).
            'accessible_organization_ids' => $user->siteAccess()->pluck('organizations.id'),
        ];
    }
}
