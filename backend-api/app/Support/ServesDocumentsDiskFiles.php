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
}
