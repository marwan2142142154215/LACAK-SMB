<?php

namespace App\Services;

use App\Models\ApkBuild;
use App\Models\Organization;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Storage;
use RuntimeException;

/**
 * Build APK on-demand per site lewat WSL2 (Gradle tidak bisa jalan langsung
 * di Windows native di mesin ini -- lihat catatan proyek). Dipanggil dari
 * App\Jobs\BuildApkJob (antrean database, standar 1.7: antrean transaksional
 * wajib PostgreSQL), bukan langsung dari controller, supaya request HTTP
 * dashboard/bot Telegram/APK master tidak menunggu 30-90 detik build Gradle.
 */
class ApkBuilder
{
    public function build(ApkBuild $apkBuild): void
    {
        $organization = Organization::findOrFail($apkBuild->organization_id);

        // Tipe 'server' tidak lewat Gradle -- langsung menyalin lacak-server.exe
        // yang sudah jadi (bangunan server-gui).
        if ($apkBuild->apk_type === 'server') {
            $exePathWindows = config('lacaksmb.server_exe_path');

            if (! is_file($exePathWindows)) {
                $apkBuild->update([
                    'status' => 'failed',
                    'build_log' => "lacak-server.exe tidak ditemukan di: {$exePathWindows}\nBangun dulu dengan: python -m PyInstaller --onefile server-gui/lacak_server.py",
                ]);

                return;
            }

            $checksum = hash_file('sha256', $exePathWindows);
            $storedPath = "apk-builds/{$organization->id}/server-{$apkBuild->id}.exe";
            $disk = config('filesystems.documents_disk');
            Storage::disk($disk)->put($storedPath, file_get_contents($exePathWindows));

            $apkBuild->update([
                'status' => 'success',
                'file_path' => $storedPath,
                'embedded_site_code' => $organization->unique_site_code,
                'checksum_sha256' => $checksum,
                'build_log' => "Server controller disalin sebagai artefak (tanpa build Gradle).\nSumber: {$exePathWindows}",
            ]);

            return;
        }

        $projectPath = $apkBuild->apk_type === 'master'
            ? config('lacaksmb.master_project_path')
            : config('lacaksmb.tracker_project_path');

        $scriptPathWindows = rtrim($projectPath, '/\\').'/scripts/build_only.sh';
        $scriptPathWsl = $this->toWslPath($scriptPathWindows);

        // APK master bersifat UNIVERSAL -- bukan milik salah satu site. Akses
        // ke site ditentukan oleh akun yang login (role + site_access), bukan
        // dari kode site yang ditanam saat build. Karena itu kode/nama site
        // generik dipakai biar build tetap bisa lewat skrip yang sama.
        $siteCode = $apkBuild->apk_type === 'master' ? 'MASTER-UNIVERSAL' : $organization->unique_site_code;
        $siteName = $apkBuild->apk_type === 'master' ? 'Lacak SMB' : $organization->name;

        // SENGAJA '--exec' ('-e'), BUKAN '--' -- dengan '--', wsl.exe di
        // Windows menggabungkan semua argumen setelah '--' jadi satu string
        // lalu menjalankannya lewat shell default Linux ("$SHELL -c '...'"),
        // yang berarti karakter shell seperti $(...) atau backtick di salah
        // satu argumen (misalnya version atau siteName yang berasal dari
        // input pengguna) DIEKSEKUSI ULANG oleh bash di dalam WSL --
        // command injection. '--exec' menjalankan command langsung tanpa
        // lewat shell default itu, jadi tiap argumen sampai ke bash sebagai
        // argv literal, bukan teks yang di-parse ulang.
        $command = [
            'wsl', '-d', config('lacaksmb.wsl_distro'), '--exec', 'bash', $scriptPathWsl,
            $siteCode,
            config('lacaksmb.public_gateway_url'),
            $siteName,
            $apkBuild->version,
            config('lacaksmb.public_backend_api_url'),
            // Identitas zero-touch (lihat ApkBuildController::generate) --
            // cuma terisi untuk apk_type='tracker', device_secret TIDAK PERNAH
            // ikut $fillable Device jadi dibaca lewat properti langsung di
            // sini, bukan lewat accessor publik mana pun.
            $apkBuild->device?->device_uuid ?? '',
            $apkBuild->device?->device_secret ?? '',
        ];

        $result = Process::timeout(300)->run($command);

        $output = $result->output().$result->errorOutput();

        if (! $result->successful()) {
            $apkBuild->update([
                'status' => 'failed',
                'build_log' => mb_substr($output, -5000),
            ]);

            Log::warning('Build APK gagal', ['apk_build_id' => $apkBuild->id, 'exit_code' => $result->exitCode()]);

            return;
        }

        if (! str_contains($output, 'APK_PATH=')) {
            $apkBuild->update([
                'status' => 'failed',
                'build_log' => mb_substr($output, -5000)."\n\n(Tidak menemukan baris APK_PATH di output build)",
            ]);

            return;
        }

        // SENGAJA tidak memakai path dari baris APK_PATH= apa adanya -- itu
        // path ala WSL (/mnt/c/...) karena skrip jalan di dalam WSL, padahal
        // proses PHP ini jalan di Windows native. Dihitung ulang langsung
        // dari config Windows-nya supaya is_file()/file_get_contents() benar.
        $apkPathWindows = rtrim($projectPath, '/\\').'/app/build/outputs/apk/debug/app-debug.apk';

        if (! is_file($apkPathWindows)) {
            $apkBuild->update([
                'status' => 'failed',
                'build_log' => "File APK hasil build tidak ditemukan di: {$apkPathWindows}",
            ]);

            return;
        }

        $checksum = hash_file('sha256', $apkPathWindows);
        $disk = config('filesystems.documents_disk');
        $storedPath = "apk-builds/{$organization->id}/{$apkBuild->apk_type}-{$apkBuild->id}.apk";

        Storage::disk($disk)->put($storedPath, file_get_contents($apkPathWindows));

        $apkBuild->update([
            'status' => 'success',
            'file_path' => $storedPath,
            'embedded_site_code' => $siteCode,
            'checksum_sha256' => $checksum,
            'build_log' => mb_substr($output, -5000),
        ]);
    }

    /** "C:\Users\X\lacak\foo" -> "/mnt/c/Users/X/lacak/foo" (konvensi WSL2). */
    private function toWslPath(string $windowsPath): string
    {
        $normalized = str_replace('\\', '/', $windowsPath);

        if (! preg_match('#^([A-Za-z]):/(.*)$#', $normalized, $matches)) {
            throw new RuntimeException("Path Windows tidak valid: {$windowsPath}");
        }

        return '/mnt/'.strtolower($matches[1]).'/'.$matches[2];
    }
}
