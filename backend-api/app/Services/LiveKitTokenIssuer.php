<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use RuntimeException;
use Throwable;

/**
 * Menerbitkan access token LiveKit (JWT HS256) untuk fitur Live Kerja.
 *
 * Token inilah satu-satunya pagar isolasi antar-site: LiveKit server hanya
 * mengizinkan pemegang token masuk ke room yang tertulis di klaim
 * `video.room`, dan room itu SELALU diturunkan dari organization_id yang
 * sudah lolos ResolvesOrganizationScope di controller -- bukan dari input
 * client. Jadi staf site A secara teknis tidak bisa ikut/menonton room
 * site B walau memodifikasi aplikasinya sendiri.
 *
 * Ditulis manual (bukan pakai SDK PHP LiveKit) karena formatnya cuma JWT
 * HS256 biasa dengan beberapa klaim -- menghindari dependency baru untuk
 * ~30 baris kode. Spesifikasi klaim: https://docs.livekit.io/home/get-started/authentication/
 */
class LiveKitTokenIssuer
{
    public static function roomForOrganization(int $organizationId): string
    {
        return "site-{$organizationId}";
    }

    /**
     * Token untuk staf yang sedang "Mulai Kerja": boleh menyiarkan kamera
     * (tanpa mikrofon/berbagi layar) dan menonton rekan se-site.
     */
    public function broadcasterToken(int $organizationId, int $userId, string $displayName): string
    {
        return $this->issue("user-{$userId}", $displayName, [
            'room' => self::roomForOrganization($organizationId),
            'roomJoin' => true,
            'canPublish' => true,
            'canPublishSources' => ['camera'],
            'canSubscribe' => true,
            'canPublishData' => false,
            'canUpdateOwnMetadata' => false,
        ]);
    }

    /**
     * Token tonton-saja (admin/leader/super_admin, atau staf yang belum
     * mulai kerja). `hidden` supaya penonton tidak muncul sebagai peserta
     * di grid orang lain; identity diberi akhiran acak supaya user yang
     * sama boleh menonton dari beberapa tab/perangkat sekaligus (LiveKit
     * menendang koneksi lama kalau identity-nya kembar).
     */
    public function viewerToken(int $organizationId, int $userId, string $displayName): string
    {
        return $this->issue("viewer-{$userId}-".bin2hex(random_bytes(4)), $displayName, [
            'room' => self::roomForOrganization($organizationId),
            'roomJoin' => true,
            'canPublish' => false,
            'canSubscribe' => true,
            'canPublishData' => false,
            'canUpdateOwnMetadata' => false,
            'hidden' => true,
        ]);
    }

    /**
     * Paksa keluarkan staf dari room site-nya (sesi ditutup karena timeout
     * atau oleh server). Tanpa ini, browser yang "zombie" -- tab tertinggal
     * terbuka tapi heartbeat-nya gagal -- tetap menyiarkan walau sesi kerja
     * di database sudah selesai. Best-effort: kegagalan hanya dicatat,
     * karena token LiveKit-nya sendiri juga tidak bisa dipakai join ulang
     * setelah kedaluwarsa.
     */
    public function removeBroadcaster(int $organizationId, int $userId): void
    {
        $room = self::roomForOrganization($organizationId);
        $httpUrl = preg_replace('#^ws(s?)://#', 'http$1://', rtrim(config('lacaksmb.livekit.url'), '/'));

        try {
            $response = Http::withToken($this->issue('backend-api', 'backend-api', ['room' => $room, 'roomAdmin' => true]))
                ->timeout(5)
                ->post("{$httpUrl}/twirp/livekit.RoomService/RemoveParticipant", [
                    'room' => $room,
                    'identity' => "user-{$userId}",
                ]);

            // 404 = staf memang sudah tidak ada di room (kasus normal saat
            // tab sudah ditutup), bukan kegagalan.
            if ($response->failed() && $response->status() !== 404) {
                Log::warning('Gagal mengeluarkan staf dari room LiveKit', ['room' => $room, 'user_id' => $userId, 'status' => $response->status()]);
            }
        } catch (Throwable $e) {
            Log::warning('Gagal menghubungi LiveKit untuk mengeluarkan staf', ['room' => $room, 'user_id' => $userId, 'error' => $e->getMessage()]);
        }
    }

    private function issue(string $identity, string $displayName, array $videoGrant): string
    {
        $apiKey = config('lacaksmb.livekit.api_key');
        $apiSecret = config('lacaksmb.livekit.api_secret');

        if (blank($apiKey) || blank($apiSecret)) {
            throw new RuntimeException('LIVEKIT_API_KEY / LIVEKIT_API_SECRET belum diisi di .env');
        }

        $now = time();
        $claims = [
            'iss' => $apiKey,
            'sub' => $identity,
            'jti' => $identity,
            'name' => $displayName,
            'nbf' => $now,
            'exp' => $now + config('lacaksmb.livekit.token_ttl_seconds'),
            'video' => $videoGrant,
        ];

        $segments = [
            $this->base64UrlEncode(json_encode(['alg' => 'HS256', 'typ' => 'JWT'])),
            $this->base64UrlEncode(json_encode($claims, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)),
        ];
        $segments[] = $this->base64UrlEncode(hash_hmac('sha256', implode('.', $segments), $apiSecret, true));

        return implode('.', $segments);
    }

    private function base64UrlEncode(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }
}
