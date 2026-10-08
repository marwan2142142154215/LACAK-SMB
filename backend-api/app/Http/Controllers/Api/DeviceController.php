<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreDeviceRequest;
use App\Http\Requests\UpdateDeviceRequest;
use App\Http\Resources\DeviceResource;
use App\Http\Responses\ApiResponse;
use App\Models\ConsentDocument;
use App\Models\Device;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Http\Request;

class DeviceController extends Controller
{
    use ApiResponse, ResolvesOrganizationScope;

    public function index(Request $request)
    {
        $request->user()->can('devices.view') || abort(403);

        $query = $this->scopeToOrganization(
            Device::query()->with(['organization', 'locations' => fn ($q) => $q->latest('recorded_at')->limit(1)]),
            $request->user(),
            $request->integer('organization_id') ?: null
        );

        if ($query === null) {
            return $this->fail('Anda tidak berwenang melihat device site ini', null, 403);
        }

        if ($status = $request->string('status')->toString()) {
            $query->where('status', $status);
        }

        $devices = $query->orderBy('device_name')->paginate($request->integer('per_page', 20));

        return $this->success('Daftar device', [
            'items' => DeviceResource::collection($devices),
            'total' => $devices->total(),
        ]);
    }

    public function store(StoreDeviceRequest $request)
    {
        $organizationId = $this->authorizedOrganizationId($request->user(), (int) $request->validated('organization_id'));

        if ($organizationId === null) {
            return $this->fail('Anda tidak berwenang mendaftarkan device untuk site ini', null, 403);
        }

        $consent = ConsentDocument::find($request->validated('consent_document_id'));

        // Tidak ada device tanpa consent yang sah dan masih berlaku — ditegakkan
        // di aplikasi, bukan cuma di skema DB (lihat docs/skema-database.md).
        if (! $consent || $consent->organization_id !== $organizationId) {
            return $this->fail('Dokumen consent tidak ditemukan untuk site ini', null, 422);
        }

        if (! $consent->isActive()) {
            return $this->fail('Dokumen consent sudah dicabut/kedaluwarsa, tidak bisa dipakai mendaftarkan device', null, 422);
        }

        $device = Device::create([
            'organization_id' => $organizationId,
            'consent_document_id' => $consent->id,
            'device_name' => $request->validated('device_name'),
            'device_uuid' => $request->validated('device_uuid'),
            'android_version' => $request->validated('android_version'),
            'app_build_version' => $request->validated('app_build_version'),
            'site_code_embedded' => $request->validated('site_code_embedded'),
            'status' => 'pending_enrollment',
            'enrolled_at' => now(),
            'is_active' => true,
            'created_by' => $request->user()->id,
            'updated_by' => $request->user()->id,
        ]);

        return $this->success('Device berhasil didaftarkan', new DeviceResource($device), 201);
    }

    public function show(Request $request, Device $device)
    {
        $request->user()->can('devices.view') || abort(403);

        if ($this->authorizedOrganizationId($request->user(), $device->organization_id) === null) {
            return $this->fail('Anda tidak berwenang melihat device ini', null, 403);
        }

        $device->load(['locations' => fn ($q) => $q->latest('recorded_at')->limit(1)]);

        return $this->success('Detail device', new DeviceResource($device));
    }

    public function update(UpdateDeviceRequest $request, Device $device)
    {
        if ($this->authorizedOrganizationId($request->user(), $device->organization_id) === null) {
            return $this->fail('Anda tidak berwenang mengubah device ini', null, 403);
        }

        $device->update([
            ...$request->validated(),
            'updated_by' => $request->user()->id,
        ]);

        return $this->success('Device berhasil diperbarui', new DeviceResource($device));
    }

    public function destroy(Request $request, Device $device)
    {
        $request->user()->can('devices.manage') || abort(403);

        if ($this->authorizedOrganizationId($request->user(), $device->organization_id) === null) {
            return $this->fail('Anda tidak berwenang menghapus device ini', null, 403);
        }

        $device->delete();

        return $this->success('Device berhasil dihapus (soft delete)');
    }
}
