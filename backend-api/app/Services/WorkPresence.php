<?php

namespace App\Services;

use App\Models\User;
use App\Models\WorkSession;
use App\Models\WorkSessionEvent;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;

/**
 * Status kerja staf & log kejadiannya (Live Kerja).
 *
 * Status dihitung dari sesi kerja yang terbuka, dengan urutan prioritas:
 * offline -> disconnected -> break -> alert (kamera & layar sama-sama mati)
 * -> camera_off -> screen_off -> idle -> working. Setiap kejadian menyimpan
 * status SETELAH kejadian itu, jadi jam kerja aktual = jumlah selang waktu
 * yang statusnya `working` (lihat summarize()).
 */
class WorkPresence
{
    public const WORKING = 'working';

    public const IDLE = 'idle';

    public const BREAK = 'break';

    public const DISCONNECTED = 'disconnected';

    public const SCREEN_OFF = 'screen_off';

    public const CAMERA_OFF = 'camera_off';

    public const OFFLINE = 'offline';

    public const ALERT = 'alert';

    /** Heartbeat dikirim tiap 30 detik; lewat dari ini staf dianggap terputus. */
    public const DISCONNECTED_AFTER_SECONDS = 75;

    /** Kamera & layar sama-sama mati lebih lama dari ini setelah mulai kerja -> ALERT. */
    public const ALERT_GRACE_SECONDS = 60;

    /** Perubahan kolom sesi -> [tipe kejadian saat jadi true, saat jadi false]. */
    private const STATE_EVENTS = [
        'camera_active' => ['camera_start', 'camera_stop'],
        'screen_active' => ['screen_start', 'screen_stop'],
        'on_break' => ['break_start', 'break_end'],
        'idle' => ['idle_start', 'idle_end'],
    ];

    public function statusOf(?WorkSession $session): string
    {
        if (! $session || $session->ended_at) {
            return self::OFFLINE;
        }

        if ($session->disconnected_at || $session->last_heartbeat_at->lt(now()->subSeconds(self::DISCONNECTED_AFTER_SECONDS))) {
            return self::DISCONNECTED;
        }

        return match (true) {
            $session->on_break => self::BREAK,
            // Detik-detik pertama sesi kamera memang belum menyala -- jangan
            // langsung ALERT setiap kali staf menekan "Mulai kerja".
            ! $session->camera_active && ! $session->screen_active => $session->started_at->gt(now()->subSeconds(self::ALERT_GRACE_SECONDS))
                ? self::CAMERA_OFF
                : self::ALERT,
            ! $session->camera_active => self::CAMERA_OFF,
            ! $session->screen_active => self::SCREEN_OFF,
            $session->idle => self::IDLE,
            default => self::WORKING,
        };
    }

    /** Catat kejadian dengan status staf saat ini (sesudah kejadian). */
    public function record(User $user, string $type, ?WorkSession $session = null, ?int $organizationId = null): WorkSessionEvent
    {
        return WorkSessionEvent::create([
            'user_id' => $user->id,
            'organization_id' => $session?->organization_id ?? $organizationId ?? $user->organization_id,
            'work_session_id' => $session?->id,
            'type' => $type,
            'status' => $this->statusOf($session?->ended_at ? null : $session),
            'occurred_at' => now(),
        ]);
    }

    /**
     * Terapkan laporan status dari aplikasi staf (heartbeat) ke sesi, lalu
     * catat satu kejadian untuk tiap kolom yang benar-benar berubah.
     *
     * @param  array{camera_active?: bool, screen_active?: bool, on_break?: bool, idle?: bool}  $state
     */
    public function applyState(WorkSession $session, array $state): void
    {
        $wasDisconnected = $session->disconnected_at !== null;
        $session->update(['last_heartbeat_at' => now(), 'disconnected_at' => null]);

        if ($wasDisconnected) {
            $this->record($session->user, 'reconnected', $session);
        }

        // Satu kolom per langkah, supaya status di tiap baris log adalah
        // status tepat setelah perubahan itu saja.
        foreach (array_intersect_key($state, self::STATE_EVENTS) as $column => $value) {
            if ($session->{$column} === (bool) $value) {
                continue;
            }

            $session->update([$column => (bool) $value]);
            $this->record($session->user, self::STATE_EVENTS[$column][$value ? 0 : 1], $session);
        }
    }

    /** Tutup sesi + catat layar/kamera berhenti lalu kejadian penutupnya. */
    public function closeSession(WorkSession $session, string $reason, string $eventType): void
    {
        foreach (['screen_active' => 'screen_stop', 'camera_active' => 'camera_stop'] as $column => $type) {
            if ($session->{$column}) {
                $session->update([$column => false]);
                $this->record($session->user, $type, $session);
            }
        }

        $session->close($reason);
        $this->record($session->user, $eventType, $session);
    }

    /**
     * Ringkasan per staf untuk satu rentang waktu: jam kerja aktual (selang
     * berstatus working), istirahat, login pertama, dan status terakhir.
     * Status sebelum rentang diambil dari kejadian terakhir sebelum `from`,
     * jadi sesi yang melewati tengah malam tetap terhitung benar.
     *
     * @param  Collection<int, WorkSessionEvent>  $events  kejadian dalam rentang, urut waktu
     * @param  Collection<int, WorkSessionEvent>  $before  kejadian terakhir sebelum `from`, per user_id
     * @return array<int, array{user_id: int, user_name: ?string, work_seconds: int, break_seconds: int, first_login_at: ?string, status: string}>
     */
    public function summarize(Collection $events, Collection $before, Carbon $from, Carbon $to): array
    {
        $end = $to->copy()->min(now());
        $summary = [];

        foreach ($events->groupBy('user_id')->union($before->map(fn ($event) => collect())) as $userId => $userEvents) {
            $status = $before->get($userId)?->status ?? self::OFFLINE;
            $cursor = $from->copy();
            $totals = [self::WORKING => 0, self::BREAK => 0];

            foreach ($userEvents as $event) {
                $totals[$status] = ($totals[$status] ?? 0) + (int) $cursor->diffInSeconds($event->occurred_at, true);
                $status = $event->status;
                $cursor = $event->occurred_at->copy();
            }

            if ($cursor->lt($end)) {
                $totals[$status] = ($totals[$status] ?? 0) + (int) $cursor->diffInSeconds($end, true);
            }

            $user = $userEvents->first()?->user ?? $before->get($userId)?->user;
            $summary[] = [
                'user_id' => $userId,
                'user_name' => $user?->name,
                'work_seconds' => $totals[self::WORKING],
                'break_seconds' => $totals[self::BREAK],
                'first_login_at' => $userEvents->firstWhere('type', 'login')?->occurred_at?->toIso8601String(),
                'status' => $status,
            ];
        }

        return collect($summary)->sortBy('user_name')->values()->all();
    }
}
