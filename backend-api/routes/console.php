<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// Live Kerja: tutup sesi yang heartbeat-nya berhenti (butuh `php artisan
// schedule:work` / cron `schedule:run` aktif di server).
Schedule::command('work-sessions:close-stale')->everyMinute()->withoutOverlapping();
