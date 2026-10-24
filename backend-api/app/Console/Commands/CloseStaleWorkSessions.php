<?php

namespace App\Console\Commands;

use App\Models\WorkSession;
use App\Services\LiveKitTokenIssuer;
use App\Services\WorkPresence;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;

/**
 * Menutup sesi Live Kerja yang heartbeat-nya berhenti (tab ditutup, HP mati,
 * sinyal hilang) supaya daftar "sedang live" dan audit trail tidak berisi
 * sesi yang sebenarnya sudah lama putus. Dijadwalkan tiap menit di
 * routes/console.php.
 */
#[Signature('work-sessions:close-stale')]
#[Description('Menutup sesi Live Kerja yang tidak mengirim heartbeat lagi')]
class CloseStaleWorkSessions extends Command
{
    public function handle(LiveKitTokenIssuer $tokenIssuer, WorkPresence $presence): int
    {
        // Heartbeat telat tapi belum lewat batas tutup -> catat "terputus"
        // sekali (status DISCONNECTED); heartbeat berikutnya mencatat
        // "tersambung lagi" (lihat WorkPresence::applyState).
        WorkSession::open()
            ->whereNull('disconnected_at')
            ->where('last_heartbeat_at', '<', now()->subSeconds(WorkPresence::DISCONNECTED_AFTER_SECONDS))
            ->with('user')
            ->each(function (WorkSession $session) use ($presence) {
                $session->update(['disconnected_at' => now()]);
                $presence->record($session->user, 'disconnected', $session);
            });

        $cutoff = now()->subSeconds(config('lacaksmb.livekit.heartbeat_timeout_seconds'));
        $closed = 0;

        WorkSession::open()
            ->where('last_heartbeat_at', '<', $cutoff)
            ->with('user')
            ->each(function (WorkSession $session) use ($tokenIssuer, $presence, &$closed) {
                $presence->closeSession($session, 'timeout', 'timeout');
                $tokenIssuer->removeBroadcaster($session->organization_id, $session->user_id);
                $closed++;
            });

        $this->info("{$closed} sesi kerja ditutup karena timeout.");

        return self::SUCCESS;
    }
}
