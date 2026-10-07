<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreApkBuildRequest;
use App\Http\Resources\ApkBuildResource;
use App\Http\Responses\ApiResponse;
use App\Models\ApkBuild;
use App\Models\Organization;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;

/**
 * Registry APK pelacak per site. embedded_site_code + checksum dipakai APK
 * saat start untuk menolak jalan kalau ada duplikasi kode site dengan
 * checksum berbeda (APK bajakan) -> tampilkan "silahkan download dari
 * sumber resmi bosku" di sisi APK (lihat android-tracked-app, tahap berikutnya).
 */
class ApkBuildController extends Controller
{
    use ApiResponse, ResolvesOrganizationScope;

    public function index(Request $request)
    {
        $request->user()->can('apk-builds.manage') || abort(403);

        $query = $this->scopeToOrganization(ApkBuild::query(), $request->user(), $request->integer('organization_id') ?: null);

        if ($query === null) {
            return $this->fail('Anda tidak berwenang melihat APK build site ini', null, 403);
        }

        $builds = $query->latest('id')->paginate($request->integer('per_page', 20));

        return $this->success('Daftar APK build', [
            'items' => ApkBuildResource::collection($builds),
            'total' => $builds->total(),
        ]);
    }

    public function store(StoreApkBuildRequest $request)
    {
        $organizationId = $this->authorizedOrganizationId($request->user(), (int) $request->validated('organization_id'));

        if ($organizationId === null) {
            return $this->fail('Anda tidak berwenang mengunggah APK untuk site ini', null, 403);
        }

        $organization = Organization::findOrFail($organizationId);
        $disk = config('filesystems.documents_disk');

        $file = $request->file('apk_file');
        $checksum = hash_file('sha256', $file->getRealPath());
        $path = $file->store("apk-builds/{$organizationId}", $disk);

        $build = ApkBuild::create([
            'organization_id' => $organizationId,
            'version' => $request->validated('version'),
            'file_path' => $path,
            'embedded_site_code' => $organization->unique_site_code,
            'checksum_sha256' => $checksum,
            'built_by' => $request->user()->id,
            'created_at' => now(),
        ]);

        return $this->success('APK berhasil diunggah dan didaftarkan', new ApkBuildResource($build), 201);
    }

    public function download(Request $request, ApkBuild $apkBuild)
    {
        if (! $request->hasValidSignature()) {
            return $this->fail('Tautan kedaluwarsa atau tidak valid', null, 403);
        }

        $disk = config('filesystems.documents_disk');

        if (! Storage::disk($disk)->exists($apkBuild->file_path)) {
            return $this->fail('Berkas APK tidak ditemukan', null, 404);
        }

        $filename = "lacak-smb-{$apkBuild->embedded_site_code}-v{$apkBuild->version}.apk";

        return Storage::disk($disk)->download($apkBuild->file_path, $filename);
    }
}
