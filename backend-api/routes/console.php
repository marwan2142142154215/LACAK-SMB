<?php

use App\Jobs\RecordQueueHeartbeat;
use App\Services\ServerStatus;
use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// Live Kerja: tutup sesi yang heartbeat-nya berhenti (butuh `php artisan
// schedule:work` / cron `schedule:run` aktif di server).
Schedule::command('work-sessions:close-stale')->everyMinute()->withoutOverlapping();

// Status server: detak scheduler (ditulis langsung) dan detak queue worker
// (lewat job -- baru tercatat kalau worker benar-benar memproses antrean).
Schedule::call(fn () => ServerStatus::recordSchedulerHeartbeat())->everyMinute()->name('server-status:scheduler-heartbeat');
Schedule::job(new RecordQueueHeartbeat)->everyMinute()->name('server-status:queue-heartbeat');
