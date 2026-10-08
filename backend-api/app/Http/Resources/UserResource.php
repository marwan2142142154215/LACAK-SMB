<?php

namespace App\Http\Resources;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin User */
class UserResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'username' => $this->username,
            'email' => $this->email,
            'organization_id' => $this->organization_id,
            'role' => $this->roles->first()?->name,
            'site_access' => $this->whenLoaded('siteAccess', fn () => $this->siteAccess->map(fn ($org) => [
                'id' => $org->id,
                'name' => $org->name,
            ])),
            'is_active' => $this->is_active,
            'created_at' => $this->created_at,
        ];
    }
}
