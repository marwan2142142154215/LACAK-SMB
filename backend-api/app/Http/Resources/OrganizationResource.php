<?php

namespace App\Http\Resources;

use App\Models\Organization;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin Organization */
class OrganizationResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'type' => $this->type,
            'unique_site_code' => $this->unique_site_code,
            'is_active' => $this->is_active,
            'devices_count' => $this->whenCounted('devices'),
            'created_at' => $this->created_at,
            'updated_at' => $this->updated_at,
        ];
    }
}
