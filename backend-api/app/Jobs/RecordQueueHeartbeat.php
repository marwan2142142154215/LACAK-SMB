<?php

namespace App\Jobs;

use App\Services\ServerStatus;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * Dikirim scheduler tiap menit; saat queue worker memprosesnya, detak antrean
 * tercatat -- dasar status "Antrean" di halaman Status server.
 */
class RecordQueueHeartbeat implements ShouldQueue
{
    use Queueable;

    public $tries = 1;

    public function handle(): void
    {
        ServerStatus::recordQueueHeartbeat();
    }
}
