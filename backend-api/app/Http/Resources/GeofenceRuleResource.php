<?php

namespace App\Http\Resources;

use App\Models\GeofenceRule;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin GeofenceRule */
class GeofenceRuleResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'organization_id' => $this->organization_id,
            'rule_name' => $this->rule_name,
            'allowed_ssid' => $this->allowed_ssid,
            'allowed_ip_cidr' => $this->allowed_ip_cidr,
            'max_distance_meters' => $this->max_distance_meters,
            'center_latitude' => $this->center_latitude !== null ? (float) $this->center_latitude : null,
            'center_longitude' => $this->center_longitude !== null ? (float) $this->center_longitude : null,
            'is_active' => $this->is_active,
            'created_at' => $this->created_at,
        ];
    }
}
