<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\GenerateApkBuildRequest;
use App\Http\Requests\StoreApkBuildRequest;
use App\Http\Resources\ApkBuildResource;
use App\Http\Responses\ApiResponse;
use App\Jobs\BuildApkJob;
use App\Models\ApkBuild;
use App\Models\ConsentDocument;
use App\Models\Device;
use App\Models\Organization;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

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

        $builds = $query->with('organization')->latest('id')->paginate($request->integer('per_page', 20));

        return $this->success('Daftar APK build', [
            'items' => ApkBuildResource::collection($builds),
            'total' => $builds->total(),
        ]);
    }

    public function show(Request $request, ApkBuild $apkBuild)
    {
        $request->user()->can('apk-builds.manage') || abort(403);

        if ($this->authorizedOrganizationId($request->user(), $apkBuild->organization_id) === null) {
            return $this->fail('Anda tidak berwenang melihat APK build site ini', null, 403);
        }

        return $this->success('Detail APK build', new ApkBuildResource($apkBuild));
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

    /**
     * Memicu build APK sungguhan (tracker atau master) untuk satu site,
     * lewat antrean (BuildApkJob -> App\Services\ApkBuilder, Gradle via
     * WSL2). Dipakai dashboard web, bot Telegram, dan APK master -- ketiganya
     * cukup panggil endpoint ini, tidak ada jalur upload manual yang perlu
     * diikuti lagi. Mengembalikan baris 'pending' segera; klien polling
     * GET /apk-builds (atau index per organization_id) sampai status
     * berubah success/failed.
     */
    public function generate(GenerateApkBuildRequest $request)
    {
        $organizationId = $this->authorizedOrganizationId($request->user(), (int) $request->validated('organization_id'));

        if ($organizationId === null) {
            return $this->fail('Anda tidak berwenang membuat APK untuk site ini', null, 403);
        }

        $organization = Organization::findOrFail($organizationId);

        // Zero-touch provisioning: untuk APK tracker, baris Device dibuat DI
        // SINI -- sebelum build Gradle dipicu -- dengan device_uuid &
        // device_secret digenerate server, supaya keduanya bisa ditanam
        // langsung ke APK (lihat App\Services\ApkBuilder). Begitu APK
        // dipasang di HP tujuan, dia sudah "terdaftar & terpasangkan"
        // sepenuhnya, nol langkah manual (baca UUID dari layar, ketik ke
        // dashboard, isi kode pairing) -- cukup sama seperti device_uuid
        // yang dulu HARUS dibuat device itu sendiri saat pertama kali
        // dibuka, sekarang backend yang membuatnya lebih dulu.
        $device = null;

        if ($request->validated('apk_type') === 'tracker') {
            $consent = ConsentDocument::find($request->validated('consent_document_id'));

            if (! $consent || $consent->organization_id !== $organizationId) {
                return $this->fail('Dokumen consent tidak ditemukan untuk site ini', null, 422);
            }

            if (! $consent->isActive()) {
                return $this->fail('Dokumen consent sudah dicabut/kedaluwarsa, tidak bisa dipakai membuat APK', null, 422);
            }

            $device = Device::create([
                'organization_id' => $organizationId,
                'consent_document_id' => $consent->id,
                'device_name' => $request->validated('device_name'),
                'device_uuid' => (string) Str::uuid(),
                // Belum diketahui -- device fisiknya belum pernah terhubung.
                // Kosong, bukan placeholder palsu seperti "unknown", supaya
                // nilai beneran begitu device:hello pertama diterima gateway
                // tidak ambigu dengan string yang sengaja dikosongkan admin.
                'android_version' => '',
                'app_build_version' => $request->validated('version') ?: '1.0.0',
                'site_code_embedded' => $organization->unique_site_code,
                'status' => 'pending_enrollment',
                'enrolled_at' => now(),
                'is_active' => true,
                'created_by' => $request->user()->id,
                'updated_by' => $request->user()->id,
            ]);

            // device_secret SENGAJA bukan mass-assignment (tidak ada di
            // $fillable Device, lihat model) -- assignment properti langsung
            // + save() seperti pola reset2fa di UserController.
            $device->device_secret = Str::random(40);
            $device->save();
        }

        $build = ApkBuild::create([
            'organization_id' => $organizationId,
            'device_id' => $device?->id,
            'apk_type' => $request->validated('apk_type'),
            'version' => $request->validated('version') ?: '1.0.0',
            'status' => 'pending',
            'embedded_site_code' => $organization->unique_site_code,
            'built_by' => $request->user()->id,
            'created_at' => now(),
        ]);

        BuildApkJob::dispatch($build->id);

        return $this->success(
            'Build APK dimulai, biasanya selesai dalam 1-2 menit — cek status lewat daftar APK build',
            new ApkBuildResource($build),
            202,
        );
    }

    /**
     * Hapus APK build terdaftar (berdasarkan request user). File di storage
     * ikut dihapus; device yang sudah ter-download & ter-install tidak terdampak
     * karena di APK sudah tertanam site_code & gateway URL yang dipakai runtime.
     */
    public function destroy(ApkBuild $apkBuild)
    {
        $request = request();

        if (! $request->user()->can('apk-builds.manage')) {
            abort(403);
        }

        if ($this->authorizedOrganizationId($request->user(), $apkBuild->organization_id) === null) {
            return $this->fail('Anda tidak berwenang menghapus APK build site ini', null, 403);
        }

        $disk = config('filesystems.documents_disk');

        if ($apkBuild->file_path && Storage::disk($disk)->exists($apkBuild->file_path)) {
            Storage::disk($disk)->delete($apkBuild->file_path);
        }

        $apkBuild->delete();

        return $this->success('APK build dihapus dan tempat penyimpanannya dibersihkan', null);
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

        $slugName = str($apkBuild->organization?->name ?? 'site')->slug()->value();
        $ext = $apkBuild->apk_type === 'server' ? '.exe' : '.apk';

        // APK master bersifat universal (bukan milik satu site) -- nama file
        // tidak menyebut site, cukup apk-master-v{version}.apk.
        if ($apkBuild->apk_type === 'master') {
            $filename = "apk-master-v{$apkBuild->version}.apk";
        } else {
            $typeLabel = $apkBuild->apk_type === 'server' ? 'lacak-server' : 'apk-pelacak';
            $filename = "{$typeLabel}-{$slugName}-v{$apkBuild->version}{$ext}";
        }

        return Storage::disk($disk)->download($apkBuild->file_path, $filename);
    }
}
