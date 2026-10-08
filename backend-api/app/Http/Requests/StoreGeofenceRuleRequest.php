<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreGeofenceRuleRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('geofence-rules.manage');
    }

    public function rules(): array
    {
        return [
            'organization_id' => ['required', 'integer', 'exists:organizations,id'],
            'rule_name' => ['required', 'string', 'max:255'],
            'allowed_ssid' => ['nullable', 'string', 'max:255'],
            'allowed_ip_cidr' => ['nullable', 'string', 'max:50'],
            'max_distance_meters' => ['nullable', 'integer', 'min:1'],
            // Radius GPS dari titik pusat -- lihat migrasi
            // add_gps_center_to_geofence_rules_table untuk alasan kenapa ini
            // yang dipakai, bukan jarak BLE (device tidak pernah bisa kirim itu).
            'center_latitude' => ['nullable', 'numeric', 'between:-90,90'],
            'center_longitude' => ['nullable', 'numeric', 'between:-180,180'],
            // Mode BLE (presisi, butuh device anchor fisik di lokasi) --
            // alternatif dari mode GPS (longgar, otomatis, tidak butuh setup).
            'anchor_device_id' => ['nullable', 'integer', 'exists:devices,id'],
        ];
    }
}
