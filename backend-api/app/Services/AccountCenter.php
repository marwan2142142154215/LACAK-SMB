<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Klien login Account Center (layanan akun terpusat perusahaan), port dari
 * scatter/app/services/AccountCenter.ts. Account Center hanya memastikan
 * "email + password ini sah" -- akun lokal, status aktif, dan 2FA tetap
 * diputuskan AuthController.
 *
 * Jawaban yang bentuknya tidak dikenali SELALU ditolak, tidak pernah
 * dianggap berhasil: kegagalan seperti itu akan terlihat seperti login sukses
 * dan tidak ada yang melapor.
 */
class AccountCenter
{
    public const AUTHENTICATED = 'authenticated';

    public const REJECTED = 'rejected';

    public const UNAVAILABLE = 'unavailable';

    public const NOT_CONFIGURED = 'not_configured';

    private const LOGIN_PATH = '/auth/login';

    private const EMAIL_KEYS = ['email', 'user_email', 'username'];

    private const NAME_KEYS = ['name', 'full_name', 'fullname', 'display_name'];

    private const FAILURE_FLAGS = ['success', 'status', 'ok'];

    public static function isConfigured(): bool
    {
        if (! config('lacaksmb.account_center.enabled')) {
            return false;
        }

        // Wajib https: password ikut terkirim (walau terenkripsi kunci bersama).
        return preg_match('#^https://#i', self::setting('uri')) === 1
            && self::setting('name') !== ''
            && self::setting('secret') !== '';
    }

    /**
     * @return array{state: string, email?: string, name?: string|null}
     */
    public static function login(string $email, string $password): array
    {
        if (! self::isConfigured()) {
            return ['state' => self::NOT_CONFIGURED];
        }

        $key = AesCbc256::keyFrom(self::setting('secret'));
        $iv = AesCbc256::generateIv();

        // Tanpa escape "/" & unicode -- sama dengan JSON.stringify, karena
        // tanda tangan dihitung atas teks badan ini persis.
        $body = json_encode([
            'email' => $email,
            'password' => AesCbc256::encrypt($password, $key, $iv),
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        try {
            $response = Http::timeout(max(1, (int) ceil(config('lacaksmb.account_center.timeout_ms') / 1000)))
                ->acceptJson()
                ->withHeaders([
                    'X-Client-Id' => self::setting('name'),
                    'X-Client-Iv' => base64_encode($iv),
                    'Signature' => AesCbc256::encrypt($body, $key, $iv),
                ])
                ->withBody($body, 'application/json')
                ->post(self::baseUrl().self::LOGIN_PATH);
        } catch (Throwable $e) {
            Log::warning('Account Center tidak dapat dihubungi saat login', ['reason' => class_basename($e)]);

            return ['state' => self::UNAVAILABLE];
        }

        if ($response->serverError()) {
            return ['state' => self::UNAVAILABLE];
        }

        if (! $response->successful()) {
            return ['state' => self::REJECTED];
        }

        return self::readIdentity($response->json());
    }

    /**
     * @return array{state: string, email?: string, name?: string|null}
     */
    public static function readIdentity(mixed $payload): array
    {
        if (! self::isRecord($payload)) {
            return self::unreadable($payload);
        }

        // Sebagian layanan menjawab 200 untuk kegagalan sambil memantulkan
        // email yang dicoba -- penanda gagal dicek SEBELUM email dibaca.
        foreach (self::FAILURE_FLAGS as $flag) {
            $value = $payload[$flag] ?? null;
            if ($value === false || $value === 'error' || $value === 'failed') {
                return ['state' => self::REJECTED];
            }
        }

        $source = match (true) {
            self::isRecord($payload['data'] ?? null) => $payload['data'],
            self::isRecord($payload['user'] ?? null) => $payload['user'],
            default => $payload,
        };

        $email = self::pickString($source, self::EMAIL_KEYS);

        if ($email === null) {
            return self::unreadable($payload);
        }

        return [
            'state' => self::AUTHENTICATED,
            'email' => mb_strtolower($email),
            'name' => self::pickString($source, self::NAME_KEYS),
        ];
    }

    /**
     * @return array{state: string}
     */
    private static function unreadable(mixed $payload): array
    {
        // Hanya nama key yang dicatat, bukan nilainya (bisa berisi token).
        Log::warning('Jawaban Account Center tidak dikenali; login ditolak.', [
            'root_keys' => self::isRecord($payload) ? array_keys($payload) : null,
        ]);

        return ['state' => self::REJECTED];
    }

    private static function isRecord(mixed $value): bool
    {
        return is_array($value) && $value !== [] && ! array_is_list($value);
    }

    /**
     * @param  array<string, mixed>  $source
     * @param  array<int, string>  $keys
     */
    private static function pickString(array $source, array $keys): ?string
    {
        foreach ($keys as $key) {
            $value = $source[$key] ?? null;
            if (is_string($value) && trim($value) !== '') {
                return trim($value);
            }
        }

        return null;
    }

    private static function baseUrl(): string
    {
        $configured = rtrim(self::setting('uri'), '/');

        return str_ends_with($configured, self::LOGIN_PATH)
            ? substr($configured, 0, -strlen(self::LOGIN_PATH))
            : $configured;
    }

    private static function setting(string $key): string
    {
        return trim((string) config("lacaksmb.account_center.{$key}"));
    }
}
