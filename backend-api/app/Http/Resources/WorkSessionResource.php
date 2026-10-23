<?php

namespace App\Http\Resources;

use App\Models\WorkSession;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin WorkSession */
class WorkSessionResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'user_id' => $this->user_id,
            'user_name' => $this->whenLoaded('user', fn () => $this->user->name),
            'organization_id' => $this->organization_id,
            // Sama dengan identity peserta di LiveKit -- dipakai dashboard
            // untuk mencocokkan tile video ke nama staf.
            'participant_identity' => "user-{$this->user_id}",
            'started_at' => $this->started_at,
            'last_heartbeat_at' => $this->last_heartbeat_at,
            'ended_at' => $this->ended_at,
            'end_reason' => $this->end_reason,
        ];
    }
}
