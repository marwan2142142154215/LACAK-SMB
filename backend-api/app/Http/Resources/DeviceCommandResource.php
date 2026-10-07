<?php

namespace App\Http\Resources;

use App\Models\DeviceCommand;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin DeviceCommand */
class DeviceCommandResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'device_id' => $this->device_id,
            'command_type' => $this->command_type,
            'issued_by' => $this->issued_by,
            'issued_via' => $this->issued_via,
            'status' => $this->status,
            'reason_note' => $this->reason_note,
            'acknowledged_at' => $this->acknowledged_at,
            'created_at' => $this->created_at,
        ];
    }
}
