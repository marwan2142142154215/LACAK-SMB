<?php

namespace App\Http\Resources;

use App\Models\DeviceLocation;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin DeviceLocation */
class DeviceLocationResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'device_id' => $this->device_id,
            'source' => $this->source,
            'latitude' => $this->latitude,
            'longitude' => $this->longitude,
            'ble_distance_meters' => $this->ble_distance_meters,
            'ble_rssi' => $this->ble_rssi,
            'recorded_at' => $this->recorded_at,
        ];
    }
}
