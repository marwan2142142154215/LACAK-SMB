<?php

namespace App\Jobs;

use App\Models\ApkBuild;
use App\Services\ApkBuilder;
use Illuminate\Contracts\Queue\ShouldBeEncrypted;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * ShouldBeEncrypted: untuk APK tracker zero-touch, payload job membawa rahasia
 * device asli (server sendiri hanya menyimpan hash-nya), jadi tidak boleh
 * tersimpan polos di tabel jobs.
 */
class BuildApkJob implements ShouldBeEncrypted, ShouldQueue
{
    use Queueable;

    /** Build Gradle via WSL2 sungguhan butuh waktu nyata — 5 menit kelonggaran. */
    public $timeout = 300;

    public $tries = 1;

    public function __construct(public int $apkBuildId, public ?string $deviceSecret = null) {}

    public function handle(ApkBuilder $builder): void
    {
        $apkBuild = ApkBuild::find($this->apkBuildId);

        if (! $apkBuild) {
            return;
        }

        $apkBuild->update(['status' => 'building']);

        $builder->build($apkBuild, $this->deviceSecret);
    }

    public function failed(\Throwable $exception): void
    {
        ApkBuild::where('id', $this->apkBuildId)->update([
            'status' => 'failed',
            'build_log' => $exception->getMessage(),
        ]);
    }
}
