<?php

namespace App\Http\Resources;

use App\Models\Device;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin Device */
class DeviceResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'organization_id' => $this->organization_id,
            'organization_name' => $this->whenLoaded('organization', fn () => $this->organization->name),
            'consent_document_id' => $this->consent_document_id,
            'device_name' => $this->device_name,
            'device_uuid' => $this->device_uuid,
            'android_version' => $this->android_version,
            'app_build_version' => $this->app_build_version,
            'status' => $this->status,
            'battery_level' => $this->battery_level,
            'last_seen_at' => $this->last_seen_at,
            'enrolled_at' => $this->enrolled_at,
            'is_active' => $this->is_active,
            'latest_location' => DeviceLocationResource::make($this->whenLoaded('locations', fn () => $this->locations->first())),
            'created_at' => $this->created_at,
            'updated_at' => $this->updated_at,
        ];
    }
}
