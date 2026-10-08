<?php

namespace App\Jobs;

use App\Models\ApkBuild;
use App\Services\ApkBuilder;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

class BuildApkJob implements ShouldQueue
{
    use Queueable;

    /** Build Gradle via WSL2 sungguhan butuh waktu nyata — 5 menit kelonggaran. */
    public $timeout = 300;

    public $tries = 1;

    public function __construct(public int $apkBuildId) {}

    public function handle(ApkBuilder $builder): void
    {
        $apkBuild = ApkBuild::find($this->apkBuildId);

        if (! $apkBuild) {
            return;
        }

        $apkBuild->update(['status' => 'building']);

        $builder->build($apkBuild);
    }

    public function failed(\Throwable $exception): void
    {
        ApkBuild::where('id', $this->apkBuildId)->update([
            'status' => 'failed',
            'build_log' => $exception->getMessage(),
        ]);
    }
}
