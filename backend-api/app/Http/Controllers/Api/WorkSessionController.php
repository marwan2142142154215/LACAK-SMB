<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Resources\WorkSessionResource;
use App\Http\Responses\ApiResponse;
use App\Models\ApkBuild;
use App\Models\Organization;
use App\Models\WorkSession;
use App\Services\LiveKitTokenIssuer;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\URL;

/**
 * Live Kerja: staf menekan "Mulai Kerja" -> menyiarkan kamera ke semua rekan
 * SE-SITE lewat LiveKit, "Selesai Kerja" -> siaran berhenti.
 *
 * Isolasi antar-site ditegakkan di sini (bukan di dashboard): room LiveKit
 * selalu diturunkan dari organization_id staf sendiri (siaran) atau dari
 * organization_id yang lolos ResolvesOrganizationScope (menonton).
 */
class WorkSessionController extends Controller
{
    use ApiResponse, ResolvesOrganizationScope;

    public function __construct(private readonly LiveKitTokenIssuer $tokenIssuer) {}

    /**
     * Site yang boleh ditonton user ini (untuk pilihan site di dashboard),
     * beserta jumlah staf yang sedang live. GET /organizations tidak bisa
     * dipakai karena khusus organizations.manage (super_admin).
     */
    public function sites(Request $request)
    {
        $user = $request->user();
        $user->can('live.watch') || abort(403);

        // scopeToOrganization() memfilter kolom organization_id, sedangkan di
        // tabel organizations sendiri kuncinya `id` -- aturannya sama.
        $sites = Organization::query()
            ->where('is_active', true)
            ->when(! $this->hasCrossOrganizationAccess($user), fn ($q) => $q->whereIn('id', $this->hasGrantBasedAccess($user)
                ? $this->grantedOrganizationIds($user)
                : array_filter([$user->organization_id])))
            ->withCount(['workSessions as live_count' => fn ($q) => $q->whereNull('ended_at')])
            ->orderBy('name')
            ->get(['id', 'name']);

        return $this->success('Site yang bisa ditonton', $sites);
    }

    /** Staf yang sedang live di satu site + sesi milik user ini sendiri (kalau ada). */
    public function index(Request $request)
    {
        $user = $request->user();
        $user->can('live.watch') || abort(403);

        $organizationId = $this->authorizedOrganizationId($user, $request->integer('organization_id') ?: null);

        if ($organizationId === null) {
            return $this->fail('Pilih site yang boleh Anda tonton', null, 403);
        }

        $sessions = WorkSession::open()
            ->where('organization_id', $organizationId)
            ->with('user:id,name')
            ->orderBy('started_at')
            ->get();

        return $this->success('Staf yang sedang live', [
            'organization_id' => $organizationId,
            'items' => WorkSessionResource::collection($sessions),
            'my_session' => ($mine = WorkSession::open()->where('user_id', $user->id)->first())
                ? new WorkSessionResource($mine)
                : null,
        ]);
    }

    public function start(Request $request)
    {
        $user = $request->user();
        $user->can('live.broadcast') || abort(403);

        // Siaran SELALU ke site "rumah" staf -- tidak ada parameter site di
        // endpoint ini sama sekali, jadi tidak bisa diarahkan ke site lain.
        if ($user->organization_id === null) {
            return $this->fail('Akun Anda tidak terikat ke site mana pun, tidak bisa memulai siaran', null, 422);
        }

        $session = WorkSession::open()->where('user_id', $user->id)->first();

        if (! $session) {
            try {
                $session = WorkSession::create([
                    'user_id' => $user->id,
                    'organization_id' => $user->organization_id,
                    'started_at' => now(),
                    'last_heartbeat_at' => now(),
                ]);
            } catch (UniqueConstraintViolationException) {
                // Klik ganda / dua tab bersamaan -- sesi sudah dibuat oleh
                // request lain (lihat partial unique index di migrasi).
                $session = WorkSession::open()->where('user_id', $user->id)->firstOrFail();
            }
        }

        // Sesi lama dilanjutkan (reload halaman/reconnect) memakai site yang
        // tercatat di sesi, bukan organization_id terbaru staf.
        return $this->success('Mulai kerja -- siaran kamera aktif', [
            'session' => new WorkSessionResource($session),
            ...$this->connectionDetails($session->organization_id, $this->tokenIssuer->broadcasterToken($session->organization_id, $user->id, $user->name)),
        ], 201);
    }

    /**
     * Dipanggil dashboard tiap ~30 detik selama siaran. 404 berarti sesi
     * sudah ditutup server (timeout) -- dashboard wajib berhenti menyiarkan.
     */
    public function heartbeat(Request $request)
    {
        $updated = WorkSession::open()
            ->where('user_id', $request->user()->id)
            ->update(['last_heartbeat_at' => now()]);

        if ($updated === 0) {
            return $this->fail('Tidak ada sesi kerja yang aktif', null, 404);
        }

        return $this->success('Heartbeat diterima');
    }

    public function end(Request $request)
    {
        $session = WorkSession::open()->where('user_id', $request->user()->id)->first();

        if (! $session) {
            return $this->fail('Tidak ada sesi kerja yang aktif', null, 404);
        }

        $session->close('manual');
        $this->tokenIssuer->removeBroadcaster($session->organization_id, $session->user_id);

        return $this->success('Selesai kerja -- siaran kamera dihentikan', new WorkSessionResource($session));
    }

    /**
     * APK Live Kerja terbaru yang siap diunduh staf (siaran tetap jalan saat
     * pindah aplikasi / layar mati -- hal yang tidak bisa dilakukan browser
     * HP). APK ini universal, jadi build sukses terbaru dari site mana pun
     * dipakai; tautan unduh bertanda tangan & berlaku 30 menit, sama seperti
     * ApkBuildResource. data = null kalau belum pernah di-build.
     */
    public function app(Request $request)
    {
        $request->user()->can('live.broadcast') || abort(403);

        $build = ApkBuild::query()
            ->where('apk_type', 'live')
            ->where('status', 'success')
            ->whereNotNull('file_path')
            ->latest('id')
            ->first();

        return $this->success('APK Live Kerja', $build ? [
            'version' => $build->version,
            'created_at' => $build->created_at,
            'download_url' => URL::temporarySignedRoute('api.v1.apk-builds.download', now()->addMinutes(30), ['apkBuild' => $build->id]),
        ] : null);
    }

    /** Token tonton-saja untuk satu site (admin/leader/super_admin, atau staf sebelum mulai kerja). */
    public function watchToken(Request $request)
    {
        $user = $request->user();
        $user->can('live.watch') || abort(403);

        $organizationId = $this->authorizedOrganizationId($user, $request->integer('organization_id') ?: null);

        if ($organizationId === null) {
            return $this->fail('Anda tidak berwenang menonton site ini', null, 403);
        }

        return $this->success('Token tonton', $this->connectionDetails(
            $organizationId,
            $this->tokenIssuer->viewerToken($organizationId, $user->id, $user->name),
        ));
    }

    private function connectionDetails(int $organizationId, string $token): array
    {
        return [
            'livekit_url' => config('lacaksmb.livekit.url'),
            'room' => LiveKitTokenIssuer::roomForOrganization($organizationId),
            'token' => $token,
        ];
    }
}
