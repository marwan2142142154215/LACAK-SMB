<?php

namespace App\Http\Middleware;

use App\Models\ApkBuild;
use App\Models\ConsentDocument;
use App\Models\Device;
use App\Models\GeofenceRule;
use App\Models\Organization;
use App\Models\TelegramBinding;
use App\Models\TelegramUserLink;
use App\Models\User;
use Closure;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Spatie\Activitylog\Facades\LogBatch;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

/**
 * Log aktivitas sistem (audit trail): setiap aksi yang MENGUBAH sesuatu
 * lewat API -- login, kelola staf, kunci device, aturan, build APK,
 * pengaturan, dst. -- dicatat beserta pelaku, objek, site, hasil (berhasil
 * / ditolak / gagal), IP & perangkat (lihat AppServiceProvider).
 *
 * Perubahan data yang terjadi dalam permintaan yang sama (dicatat trait
 * LogsActivity di model) digabung ke catatan ini lewat batch_uuid, jadi di
 * menu Log aktivitas tampil satu baris dengan rincian "sebelum -> sesudah".
 *
 * Sengaja TIDAK dicatat: log jam kerja (Live Kerja punya log sendiri), isi
 * chat, dan permintaan baca (GET).
 */
class RecordApiActivity
{
    public const LOG_NAME = 'api';

    /**
     * Aksi yang dicatat: "Controller@method" => [kategori, pembuat kalimat].
     * Kalimat dibuat dari objek & input yang aman (tanpa password/token/berkas).
     *
     * @return array<string, array{0: string, 1: Closure(Request, ?Model, int, ?array): string}>
     */
    private function actions(): array
    {
        $name = fn (?Model $model, string $attribute, string $fallback = '') => $model?->getAttribute($attribute) ?? $fallback;
        $ok = fn (int $status) => $status < 300;

        return [
            // ---- Akun & login
            'AuthController@login' => ['auth', fn (Request $r, ?Model $m, int $s, ?array $d) => match (true) {
                $ok($s) && ($d['requires_2fa'] ?? false) => 'Password benar, menunggu kode 2FA',
                $ok($s) && ($d['requires_2fa_setup'] ?? false) => 'Password benar, diminta memasang 2FA',
                $ok($s) => 'Login berhasil',
                $s === 403 => 'Login ditolak: akun nonaktif / belum terdaftar',
                $s === 429 => 'Login diblokir sementara: terlalu banyak percobaan',
                default => 'Login gagal: username atau password salah ('.trim((string) $r->input('username')).')',
            }],
            'AuthController@verifyTwoFactor' => ['auth', fn ($r, $m, int $s) => $ok($s) ? 'Login berhasil (kode 2FA benar)' : 'Kode 2FA salah / kedaluwarsa'],
            'AuthController@confirmTwoFactorSetup' => ['auth', fn ($r, $m, int $s) => $ok($s) ? 'Memasang authenticator 2FA' : 'Gagal memasang 2FA: kode salah'],
            'AuthController@logout' => ['auth', fn () => 'Logout'],

            // ---- Staf
            'UserController@store' => ['staf', fn (Request $r) => "Menambah staf {$r->input('username')} sebagai ".$this->roleLabel($r->input('role'))],
            'UserController@update' => ['staf', fn (Request $r, ?Model $m) => $r->filled('password')
                ? "Mengganti password staf {$name($m, 'username')}"
                : "Mengubah data staf {$name($m, 'username')}".($r->filled('role') ? ' (peran: '.$this->roleLabel($r->input('role')).')' : '')],
            'UserController@destroy' => ['staf', fn ($r, ?Model $m) => "Menghapus staf {$name($m, 'username')}"],
            'UserController@suspend' => ['staf', fn ($r, ?Model $m) => "Menyuspen akun {$name($m, 'username')}"],
            'UserController@reactivate' => ['staf', fn ($r, ?Model $m) => "Mengaktifkan kembali akun {$name($m, 'username')}"],
            'UserController@reset2fa' => ['staf', fn ($r, ?Model $m) => "Mereset 2FA {$name($m, 'username')}"],
            'UserController@syncSiteAccess' => ['staf', fn ($r, ?Model $m) => "Mengubah akses site {$name($m, 'username')}"],

            // ---- Device & perintah
            'DeviceController@store' => ['device', fn (Request $r) => "Mendaftarkan device {$r->input('device_name')}"],
            'DeviceController@update' => ['device', fn ($r, ?Model $m) => "Mengubah device {$name($m, 'device_name')}"],
            'DeviceController@destroy' => ['device', fn ($r, ?Model $m) => "Menghapus device {$name($m, 'device_name')}"],
            'DeviceEnrollmentController@reEnroll' => ['device', fn ($r, ?Model $m) => "Mendaftar ulang device {$name($m, 'device_name')}"],
            'DeviceEnrollmentController@claim' => ['device', fn ($r, $m, int $s) => $ok($s) ? 'Aplikasi di perangkat mengambil kunci akses (pendaftaran)' : 'Klaim pendaftaran perangkat ditolak'],
            'DeviceCommandController@store' => ['perintah', fn (Request $r, ?Model $m) => $this->commandLabel($r->input('command_type'))." {$name($m, 'device_name')}"
                .($r->filled('reason_note') ? ' — '.mb_strimwidth((string) $r->input('reason_note'), 0, 80, '…') : '')],
            'DeviceOtpController@generate' => ['perintah', fn ($r, ?Model $m) => "Membuat OTP buka kunci untuk {$name($m, 'device_name')}"],
            'DeviceOtpController@verify' => ['perintah', fn ($r, $m, int $s) => $ok($s) ? 'Device dibuka dengan OTP' : 'OTP buka kunci salah / kedaluwarsa'],

            // ---- Aturan & consent
            'GeofenceRuleController@store' => ['aturan', fn (Request $r) => "Membuat aturan geofence {$r->input('rule_name')}"],
            'GeofenceRuleController@update' => ['aturan', fn ($r, ?Model $m) => "Mengubah aturan geofence {$name($m, 'rule_name')}"],
            'GeofenceRuleController@destroy' => ['aturan', fn ($r, ?Model $m) => "Menghapus aturan geofence {$name($m, 'rule_name')}"],
            'ConsentDocumentController@store' => ['aturan', fn (Request $r) => "Mengunggah dokumen consent {$r->input('subject_name')}"],
            'ConsentDocumentController@revoke' => ['aturan', fn ($r, ?Model $m) => "Mencabut consent {$name($m, 'subject_name')}"],

            // ---- Build APK
            'ApkBuildController@generate' => ['apk', fn (Request $r) => 'Membuat build '.$this->apkLabel($r->input('apk_type'))
                .($r->filled('version') ? ' v'.$r->input('version') : '')
                .($r->filled('device_name') ? " untuk {$r->input('device_name')}" : '')],
            'ApkBuildController@store' => ['apk', fn (Request $r) => 'Mengunggah APK manual'.($r->filled('version') ? ' v'.$r->input('version') : '')],
            'ApkBuildController@destroy' => ['apk', fn ($r, ?Model $m) => 'Menghapus build APK'.($m ? " v{$name($m, 'version')}" : '')],

            // ---- Telegram
            'TelegramBindingController@store' => ['telegram', fn (Request $r) => "Menghubungkan grup Telegram {$r->input('telegram_chat_id')}"],
            'TelegramBindingController@destroy' => ['telegram', fn ($r, ?Model $m) => "Melepas grup Telegram {$name($m, 'telegram_chat_id')}"],
            'TelegramUserLinkController@store' => ['telegram', fn (Request $r) => "Menautkan Telegram {$r->input('telegram_user_id')} ke akun staf"],
            'TelegramUserLinkController@destroy' => ['telegram', fn () => 'Menghapus tautan Telegram staf'],

            // ---- Site & pengaturan
            'OrganizationController@store' => ['site', fn (Request $r) => "Membuat site {$r->input('name')}"],
            'OrganizationController@update' => ['site', fn ($r, ?Model $m) => "Mengubah site {$name($m, 'name')}"],
            'OrganizationController@destroy' => ['site', fn ($r, ?Model $m) => "Menghapus site {$name($m, 'name')}"],
            'SecuritySettingController@update' => ['pengaturan', fn (Request $r) => $r->boolean('two_factor_required') ? 'Menyalakan 2FA wajib untuk semua akun' : 'Mematikan 2FA wajib untuk semua akun'],
        ];
    }

    /** Parameter route -> model, untuk objek yang dihapus (namanya diambil sebelum dihapus). */
    private const ROUTE_MODELS = [
        'user' => User::class,
        'device' => Device::class,
        'geofence_rule' => GeofenceRule::class,
        'consentDocument' => ConsentDocument::class,
        'apk_build' => ApkBuild::class,
        'telegram_binding' => TelegramBinding::class,
        'telegram_user_link' => TelegramUserLink::class,
        'organization' => Organization::class,
    ];

    /** Input yang aman disimpan sebagai rincian (tidak pernah password, token, kode, atau berkas). */
    private const SAFE_INPUT = [
        'username', 'name', 'email', 'role', 'organization_id', 'device_name', 'command_type', 'issued_via', 'reason_note',
        'rule_name', 'allowed_ssid', 'allowed_ip_cidr', 'max_distance_meters', 'subject_name', 'signer_name', 'signer_role',
        'apk_type', 'version', 'telegram_chat_id', 'telegram_user_id', 'telegram_username', 'two_factor_required', 'is_active',
        'organization_ids', 'client',
    ];

    public function handle(Request $request, Closure $next): Response
    {
        $action = $this->actionKey($request);
        $definition = $action && ! $request->isMethodSafe() ? ($this->actions()[$action] ?? null) : null;

        if (! $definition) {
            return $next($request);
        }

        // Objek diambil SEBELUM aksi: setelah dihapus namanya sudah tidak ada.
        $subject = $this->routeSubject($request);
        // Salinan keadaan sebelum aksi -- kalimat log memakai nama lama
        // ("Mengubah device HP Kasir", bukan nama barunya).
        $before = $subject ? clone $subject : null;

        LogBatch::startBatch();
        try {
            $response = $next($request);
            $this->record($request, $response, $action, $definition, $subject, $before);

            return $response;
        } finally {
            LogBatch::endBatch();
        }
    }

    /**
     * @param  array{0: string, 1: Closure}  $definition
     */
    private function record(Request $request, Response $response, string $action, array $definition, ?Model $subject, ?Model $before): void
    {
        try {
            $status = $response->getStatusCode();
            $data = $response instanceof JsonResponse ? ($response->getData(true)['data'] ?? null) : null;
            $data = is_array($data) ? $data : null;
            [$category, $describe] = $definition;

            // Objek baru (dibuat oleh aksi ini) diambil dari respons.
            $subject ??= $this->createdSubject($action, $data);
            $causer = $request->user();
            if (! $causer && str_starts_with($action, 'AuthController@')) {
                // Login berhasil: pelakunya pemilik akun. Login gagal: yang
                // mencoba belum tentu pemiliknya -- akun itu dicatat sebagai
                // objek (sasaran), bukan pelaku.
                $account = $this->accountFromAuthRequest($request, $data);
                $status < 300 ? $causer = $account : $subject ??= $account;
            }

            $logger = activity(self::LOG_NAME)
                ->event($action)
                ->withProperties([
                    'category' => $category,
                    'status' => $status,
                    'result' => match (true) {
                        $status < 300 => 'ok',
                        $status < 500 => 'denied',
                        default => 'failed',
                    },
                    'message' => $status >= 300 ? mb_strimwidth((string) ($response instanceof JsonResponse ? ($response->getData(true)['message'] ?? '') : ''), 0, 200, '…') : null,
                    'input' => array_filter(
                        $request->only(self::SAFE_INPUT),
                        fn ($value) => $value !== null && $value !== '',
                    ),
                    'route' => $request->method().' /'.$request->path(),
                ]);

            if ($causer) {
                $logger->causedBy($causer);
            }
            if ($subject) {
                $logger->performedOn($subject);
            }

            $logger->log($describe($request, $before ?? $subject, $status, $data));
        } catch (Throwable $exception) {
            // Mencatat log tidak boleh menggagalkan aksi utamanya.
            report($exception);
        }
    }

    private function actionKey(Request $request): ?string
    {
        $action = $request->route()?->getActionName();
        if (! $action || ! str_contains($action, '@')) {
            return null;
        }

        return class_basename(strstr($action, '@', true)).strstr($action, '@');
    }

    private function routeSubject(Request $request): ?Model
    {
        foreach ($request->route()?->parameters() ?? [] as $key => $value) {
            if ($value instanceof Model) {
                return $value;
            }
            $class = self::ROUTE_MODELS[$key] ?? null;
            if ($class && is_numeric($value)) {
                return $class::query()->find($value);
            }
        }

        return null;
    }

    private function createdSubject(string $action, ?array $data): ?Model
    {
        $class = match (strstr($action, '@', true)) {
            'UserController' => User::class,
            'DeviceController' => Device::class,
            'GeofenceRuleController' => GeofenceRule::class,
            'ConsentDocumentController' => ConsentDocument::class,
            'ApkBuildController' => ApkBuild::class,
            'OrganizationController' => Organization::class,
            'TelegramBindingController' => TelegramBinding::class,
            default => null,
        };
        $id = $data['id'] ?? null;

        return $class && is_numeric($id) ? $class::query()->find($id) : null;
    }

    /** Login & 2FA belum membawa token: akun dicari dari respons atau username yang dikirim. */
    private function accountFromAuthRequest(Request $request, ?array $data): ?User
    {
        if (isset($data['user']['id'])) {
            return User::find($data['user']['id']);
        }
        $identifier = mb_strtolower(trim((string) $request->input('username')));

        return $identifier === '' ? null : User::query()
            ->whereRaw('LOWER(username) = ?', [$identifier])
            ->orWhereRaw('LOWER(email) = ?', [$identifier])
            ->first();
    }

    private function roleLabel(?string $role): string
    {
        return match ($role) {
            'super_admin' => 'Super Admin',
            'admin' => 'Admin',
            'leader' => 'Leader',
            'site_admin' => 'Admin Site',
            'staff_viewer' => 'Staf',
            default => (string) $role,
        };
    }

    private function commandLabel(?string $command): string
    {
        return match ($command) {
            'lock' => 'Mengunci',
            'unlock' => 'Membuka kunci',
            'locate_now' => 'Meminta lokasi',
            'start_monitor' => 'Mulai memantau',
            'stop_monitor' => 'Berhenti memantau',
            default => "Perintah {$command} ke",
        };
    }

    private function apkLabel(?string $type): string
    {
        return match ($type) {
            'tracker' => 'APK pelacak',
            'master' => 'APK Master',
            'live' => 'APK Live',
            'server' => 'Server (lacak-server.exe)',
            default => 'APK',
        };
    }
}
