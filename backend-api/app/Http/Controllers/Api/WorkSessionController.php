<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Resources\WorkSessionResource;
use App\Http\Responses\ApiResponse;
use App\Models\ApkBuild;
use App\Models\Organization;
use App\Models\User;
use App\Models\WorkSession;
use App\Models\WorkSessionEvent;
use App\Services\LiveKitTokenIssuer;
use App\Services\WorkPresence;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
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

    public function __construct(
        private readonly LiveKitTokenIssuer $tokenIssuer,
        private readonly WorkPresence $presence,
    ) {}

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

    /**
     * Staf yang sedang live di satu site, status SEMUA staf site itu (termasuk
     * yang offline), dan sesi milik user ini sendiri (kalau ada).
     */
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

        $sessionsByUser = $sessions->keyBy('user_id');
        $roster = User::permission('live.broadcast')
            ->where('organization_id', $organizationId)
            ->where('is_active', true)
            ->orderBy('name')
            ->get(['id', 'name'])
            ->map(fn (User $staff) => [
                'user_id' => $staff->id,
                'name' => $staff->name,
                'participant_identity' => "user-{$staff->id}",
                'status' => $this->presence->statusOf($sessionsByUser->get($staff->id)),
                'started_at' => $sessionsByUser->get($staff->id)?->started_at,
            ]);

        return $this->success('Staf yang sedang live', [
            'organization_id' => $organizationId,
            'items' => WorkSessionResource::collection($sessions),
            'roster' => $roster,
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
                $this->presence->record($user, 'work_start', $session);
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
     * Dipanggil dashboard tiap ~30 detik selama siaran, dan langsung setiap
     * kali kamera/layar/istirahat/idle berubah. 404 berarti sesi sudah
     * ditutup server (timeout) -- dashboard wajib berhenti menyiarkan.
     */
    public function heartbeat(Request $request)
    {
        $state = $request->validate([
            'camera_active' => ['sometimes', 'boolean'],
            'screen_active' => ['sometimes', 'boolean'],
            'on_break' => ['sometimes', 'boolean'],
            'idle' => ['sometimes', 'boolean'],
        ]);

        $session = WorkSession::open()->where('user_id', $request->user()->id)->first();

        if (! $session) {
            return $this->fail('Tidak ada sesi kerja yang aktif', null, 404);
        }

        $this->presence->applyState($session, $state);

        return $this->success('Heartbeat diterima', new WorkSessionResource($session));
    }

    public function end(Request $request)
    {
        $session = WorkSession::open()->where('user_id', $request->user()->id)->first();

        if (! $session) {
            return $this->fail('Tidak ada sesi kerja yang aktif', null, 404);
        }

        $this->presence->closeSession($session, 'manual', 'work_end');
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

    /**
     * Log kerja satu site dalam satu rentang waktu (biasanya satu hari kalender
     * menurut jam perangkat penonton -- dashboard yang mengirim from/to),
     * beserta jam kerja aktual per staf.
     */
    public function activity(Request $request)
    {
        $user = $request->user();
        $user->can('live.watch') || abort(403);

        $validated = $request->validate([
            'organization_id' => ['nullable', 'integer'],
            'from' => ['required', 'date'],
            'to' => ['required', 'date', 'after:from'],
        ]);

        $organizationId = $this->authorizedOrganizationId($user, $validated['organization_id'] ?? null);

        if ($organizationId === null) {
            return $this->fail('Anda tidak berwenang melihat log site ini', null, 403);
        }

        $from = Carbon::parse($validated['from']);
        $to = Carbon::parse($validated['to']);

        if ($from->diffInDays($to) > 31) {
            return $this->fail('Rentang log maksimal 31 hari', null, 422);
        }

        $events = WorkSessionEvent::query()
            ->with('user:id,name')
            ->where('organization_id', $organizationId)
            ->whereBetween('occurred_at', [$from, $to])
            ->orderBy('occurred_at')
            ->orderBy('id')
            ->get();

        // Status tiap staf tepat sebelum rentang dimulai.
        $before = WorkSessionEvent::query()
            ->with('user:id,name')
            ->whereIn('id', WorkSessionEvent::query()
                ->selectRaw('MAX(id)')
                ->where('organization_id', $organizationId)
                ->where('occurred_at', '<', $from)
                ->groupBy('user_id'))
            ->get()
            ->keyBy('user_id');

        return $this->success('Log kerja', [
            'organization_id' => $organizationId,
            'summary' => $this->presence->summarize($events, $before, $from, $to),
            'events' => $events->map(fn (WorkSessionEvent $event) => [
                'id' => $event->id,
                'user_id' => $event->user_id,
                'user_name' => $event->user?->name,
                'type' => $event->type,
                'status' => $event->status,
                'occurred_at' => $event->occurred_at,
            ]),
        ]);
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
