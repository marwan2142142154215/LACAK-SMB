<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreGeofenceRuleRequest;
use App\Http\Resources\GeofenceRuleResource;
use App\Http\Responses\ApiResponse;
use App\Models\Device;
use App\Models\GeofenceRule;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Http\Request;

class GeofenceRuleController extends Controller
{
    use ApiResponse, ResolvesOrganizationScope;

    public function index(Request $request)
    {
        $request->user()->can('geofence-rules.manage') || abort(403);

        $query = $this->scopeToOrganization(GeofenceRule::query(), $request->user(), $request->integer('organization_id') ?: null);

        if ($query === null) {
            return $this->fail('Anda tidak berwenang melihat aturan geofence site ini', null, 403);
        }

        $rules = $query->with('anchorDevice')->orderBy('rule_name')->paginate($request->integer('per_page', 20));

        return $this->success('Daftar aturan geofence', [
            'items' => GeofenceRuleResource::collection($rules),
            'total' => $rules->total(),
        ]);
    }

    public function store(StoreGeofenceRuleRequest $request)
    {
        $organizationId = $this->authorizedOrganizationId($request->user(), (int) $request->validated('organization_id'));

        if ($organizationId === null) {
            return $this->fail('Anda tidak berwenang membuat aturan untuk site ini', null, 403);
        }

        // 'exists:devices,id' di StoreGeofenceRuleRequest cuma mengecek device-nya
        // ADA, bukan device-nya milik SITE INI -- tanpa ini, admin site A bisa
        // tanam anchor_device_id milik site B, dan nama device B ikut bocor
        // lewat GeofenceRuleResource::anchor_device_name (IDOR lintas-tenant,
        // ditemukan lewat audit keamanan menyeluruh).
        if ($request->validated('anchor_device_id') && ! Device::where('id', $request->validated('anchor_device_id'))->where('organization_id', $organizationId)->exists()) {
            return $this->fail('Device anchor harus milik site yang sama', null, 422);
        }

        $rule = GeofenceRule::create([
            'organization_id' => $organizationId,
            'rule_name' => $request->validated('rule_name'),
            'allowed_ssid' => $request->validated('allowed_ssid'),
            'allowed_ip_cidr' => $request->validated('allowed_ip_cidr'),
            'max_distance_meters' => $request->validated('max_distance_meters'),
            'center_latitude' => $request->validated('center_latitude'),
            'center_longitude' => $request->validated('center_longitude'),
            'anchor_device_id' => $request->validated('anchor_device_id'),
            'is_active' => true,
            'created_by' => $request->user()->id,
        ]);

        return $this->success('Aturan geofence berhasil dibuat', new GeofenceRuleResource($rule), 201);
    }

    public function update(Request $request, GeofenceRule $geofenceRule)
    {
        $request->user()->can('geofence-rules.manage') || abort(403);

        if ($this->authorizedOrganizationId($request->user(), $geofenceRule->organization_id) === null) {
            return $this->fail('Anda tidak berwenang mengubah aturan ini', null, 403);
        }

        $data = $request->validate([
            'rule_name' => ['sometimes', 'string', 'max:255'],
            'allowed_ssid' => ['sometimes', 'nullable', 'string', 'max:255'],
            'allowed_ip_cidr' => ['sometimes', 'nullable', 'string', 'max:50'],
            'max_distance_meters' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'center_latitude' => ['sometimes', 'nullable', 'numeric', 'between:-90,90'],
            'center_longitude' => ['sometimes', 'nullable', 'numeric', 'between:-180,180'],
            'anchor_device_id' => ['sometimes', 'nullable', 'integer', 'exists:devices,id'],
            'is_active' => ['sometimes', 'boolean'],
        ]);

        // Sama seperti store() -- 'exists' saja tidak cukup, device anchor
        // wajib milik site yang sama dengan aturan ini.
        if (! empty($data['anchor_device_id']) && ! Device::where('id', $data['anchor_device_id'])->where('organization_id', $geofenceRule->organization_id)->exists()) {
            return $this->fail('Device anchor harus milik site yang sama', null, 422);
        }

        $geofenceRule->update($data);

        return $this->success('Aturan geofence berhasil diperbarui', new GeofenceRuleResource($geofenceRule));
    }

    public function destroy(Request $request, GeofenceRule $geofenceRule)
    {
        $request->user()->can('geofence-rules.manage') || abort(403);

        if ($this->authorizedOrganizationId($request->user(), $geofenceRule->organization_id) === null) {
            return $this->fail('Anda tidak berwenang menghapus aturan ini', null, 403);
        }

        $geofenceRule->delete();

        return $this->success('Aturan geofence berhasil dihapus');
    }
}
