<?php

namespace App\Support;

use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Menyajikan berkas penting dari disk documents_disk (DigitalOcean Spaces)
 * lewat tautan bertanda waktu milik Spaces sendiri, supaya bucket tetap
 * privat dan berkas besar (APK) tidak perlu dialirkan lewat proses PHP.
 */
trait ServesDocumentsDiskFiles
{
    private const TEMPORARY_FILE_URL_MINUTES = 5;

    protected function documentsDisk(): Filesystem
    {
        return Storage::disk(config('filesystems.documents_disk'));
    }

    protected function documentsDiskFileExists(?string $path): bool
    {
        return $path !== null && $path !== '' && $this->documentsDisk()->exists($path);
    }

    protected function serveDocumentsDiskFile(string $path, string $downloadName): RedirectResponse|StreamedResponse
    {
        $diskName = config('filesystems.documents_disk');
        $storage = Storage::disk($diskName);

        // Disk lokal hanya dipakai di lingkungan dev (lihat config/filesystems.php),
        // jadi berkas dialirkan langsung tanpa tautan Spaces.
        if (config("filesystems.disks.{$diskName}.driver") !== 's3') {
            return $storage->download($path, $downloadName);
        }

        $temporaryUrl = $storage->temporaryUrl($path, now()->addMinutes(self::TEMPORARY_FILE_URL_MINUTES), [
            'ResponseContentDisposition' => 'attachment; filename="'.addslashes($downloadName).'"',
        ]);

        return redirect()->away($temporaryUrl);
    }

    /**
     * Gambar untuk ditampilkan langsung (<img>), bukan diunduh. Content-Type
     * dipaksa dari tipe yang tervalidasi saat unggah + nosniff, supaya
     * browser tidak pernah menafsirkan berkas sebagai HTML/skrip.
     */
    protected function serveImageFromDisk(string $diskName, string $path, string $mimeType): RedirectResponse|StreamedResponse
    {
        $storage = Storage::disk($diskName);

        if (config("filesystems.disks.{$diskName}.driver") !== 's3') {
            return $storage->response($path, null, [
                'Content-Type' => $mimeType,
                'Content-Disposition' => 'inline',
                'X-Content-Type-Options' => 'nosniff',
                'Cache-Control' => 'private, max-age=3600',
            ]);
        }

        $temporaryUrl = $storage->temporaryUrl($path, now()->addMinutes(self::TEMPORARY_FILE_URL_MINUTES), [
            'ResponseContentType' => $mimeType,
            'ResponseContentDisposition' => 'inline',
        ]);

        return redirect()->away($temporaryUrl);
    }
}
