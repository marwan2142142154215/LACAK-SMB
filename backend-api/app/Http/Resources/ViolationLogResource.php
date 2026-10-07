<?php

namespace App\Http\Resources;

use App\Models\ViolationLog;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin ViolationLog */
class ViolationLogResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'device_id' => $this->device_id,
            'geofence_rule_id' => $this->geofence_rule_id,
            'violation_type' => $this->violation_type,
            'detected_value' => $this->detected_value,
            'notified_telegram' => $this->notified_telegram,
            'notified_dashboard' => $this->notified_dashboard,
            'detected_at' => $this->detected_at,
        ];
    }
}
