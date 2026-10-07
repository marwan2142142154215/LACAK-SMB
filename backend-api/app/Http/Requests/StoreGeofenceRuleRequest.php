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
        ];
    }
}
