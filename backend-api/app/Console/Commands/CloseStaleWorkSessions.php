<?php

namespace App\Console\Commands;

use App\Models\WorkSession;
use App\Services\LiveKitTokenIssuer;
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
    public function handle(LiveKitTokenIssuer $tokenIssuer): int
    {
        $cutoff = now()->subSeconds(config('lacaksmb.livekit.heartbeat_timeout_seconds'));
        $closed = 0;

        WorkSession::open()
            ->where('last_heartbeat_at', '<', $cutoff)
            ->each(function (WorkSession $session) use ($tokenIssuer, &$closed) {
                $session->close('timeout');
                $tokenIssuer->removeBroadcaster($session->organization_id, $session->user_id);
                $closed++;
            });

        $this->info("{$closed} sesi kerja ditutup karena timeout.");

        return self::SUCCESS;
    }
}
