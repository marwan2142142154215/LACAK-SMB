<?php

namespace App\Providers;

use App\Models\Organization;
use Illuminate\Support\ServiceProvider;
use Spatie\Activitylog\Models\Activity;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        // Log aktivitas: setiap catatan membawa site (untuk disaring per site),
        // IP & perangkat/browser pelakunya -- baik catatan aksi API
        // (RecordApiActivity) maupun perubahan data dari trait LogsActivity.
        Activity::creating(function (Activity $activity) {
            if (! app()->runningInConsole() || app()->runningUnitTests()) {
                $request = request();
                $activity->ip_address ??= $request->ip();
                $activity->user_agent ??= mb_substr((string) $request->userAgent(), 0, 255) ?: null;
            }

            $activity->organization_id ??= match (true) {
                $activity->subject instanceof Organization => $activity->subject->getKey(),
                isset($activity->subject?->organization_id) => $activity->subject->organization_id,
                is_numeric($activity->properties['input']['organization_id'] ?? null) => (int) $activity->properties['input']['organization_id'],
                default => $activity->causer?->organization_id,
            };
        });
    }
}
