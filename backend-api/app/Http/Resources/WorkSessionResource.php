<?php

namespace App\Http\Resources;

use App\Models\WorkSession;
use App\Services\WorkPresence;
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
            'camera_active' => $this->camera_active,
            'screen_active' => $this->screen_active,
            'on_break' => $this->on_break,
            'idle' => $this->idle,
            'status' => app(WorkPresence::class)->statusOf($this->resource),
            'end_reason' => $this->end_reason,
        ];
    }
}
