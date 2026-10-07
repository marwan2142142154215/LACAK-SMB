<?php

namespace App\Http\Resources;

use App\Models\ApkBuild;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Facades\URL;

/** @mixin ApkBuild */
class ApkBuildResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'organization_id' => $this->organization_id,
            'version' => $this->version,
            'embedded_site_code' => $this->embedded_site_code,
            'checksum_sha256' => $this->checksum_sha256,
            'download_url' => URL::temporarySignedRoute(
                'api.v1.apk-builds.download',
                now()->addMinutes(30),
                ['apkBuild' => $this->id]
            ),
            'created_at' => $this->created_at,
        ];
    }
}
