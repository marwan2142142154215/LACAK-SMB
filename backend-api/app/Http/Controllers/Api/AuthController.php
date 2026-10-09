<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Responses\ApiResponse;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;
use PragmaRX\Google2FAQRCode\Google2FA;

/**
 * Alur login:
 *  1. POST /auth/login (username, password)
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

    public function login(Request $request)
    {
        $credentials = $request->validate([
            'username' => ['required', 'string'],
            'password' => ['required', 'string'],
            'client' => ['nullable', 'string', 'in:web_dashboard,master_app,telegram_bot'],
        ]);

        $user = User::where('username', $credentials['username'])->first();

        if (! $user || ! Hash::check($credentials['password'], $user->password)) {
            return $this->fail('Username atau password salah', null, 401);
        }

        if (! $user->is_active) {
            return $this->fail('Akun Anda dinonaktifkan. Hubungi super admin.', null, 403);
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

        if (! $google2fa->verifyKey($payload['secret'], $data['code'])) {
            return $this->fail('Kode 2FA salah', null, 422);
        }

        /** @var User $user */
        $user = User::findOrFail($payload['user_id']);

        $recoveryCodes = collect(range(1, 8))
            ->map(fn () => Str::random(10))
            ->values();

        $user->forceFill([
            'two_factor_secret' => Crypt::encryptString($payload['secret']),
            'two_factor_recovery_codes' => Crypt::encryptString($recoveryCodes->toJson()),
            'two_factor_confirmed_at' => now(),
        ])->save();

        Cache::forget("auth:2fa_setup:{$data['setup_token']}");

        $token = $user->createToken($this->tokenNameFor($request), ['*'], now()->addHours(self::TOKEN_IDLE_HOURS))->plainTextToken;

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
            'code' => ['required', 'digits:6'],
        ]);

        $userId = Cache::get("auth:2fa_challenge:{$data['challenge_token']}");

        if (! $userId) {
            return $this->fail('Sesi login sudah kedaluwarsa, silakan login ulang', null, 410);
        }

        /** @var User $user */
        $user = User::findOrFail($userId);

        $google2fa = new Google2FA;
        $secret = Crypt::decryptString($user->two_factor_secret);

        if (! $google2fa->verifyKey($secret, $data['code'])) {
            return $this->fail('Kode 2FA salah', null, 422);
        }

        Cache::forget("auth:2fa_challenge:{$data['challenge_token']}");

        $token = $user->createToken($this->tokenNameFor($request), ['*'], now()->addHours(self::TOKEN_IDLE_HOURS))->plainTextToken;

        return $this->success('Login berhasil', [
            'access_token' => $token,
            'token_type' => 'Bearer',
            'user' => $this->userPayload($user),
        ]);
    }

    public function logout(Request $request)
    {
        $request->user()->currentAccessToken()->delete();

        return $this->success('Berhasil logout');
    }

    public function me(Request $request)
    {
        return $this->success('Data user saat ini', $this->userPayload($request->user()));
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
