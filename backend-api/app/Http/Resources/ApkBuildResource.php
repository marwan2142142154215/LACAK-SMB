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
            'apk_type' => $this->apk_type,
            'version' => $this->version,
            'status' => $this->status,
            'embedded_site_code' => $this->embedded_site_code,
            'checksum_sha256' => $this->checksum_sha256,
            'build_log' => $this->build_log,
            'download_url' => $this->status === 'success' ? URL::temporarySignedRoute(
                'api.v1.apk-builds.download',
                now()->addMinutes(30),
                ['apkBuild' => $this->id]
            ) : null,
            'created_at' => $this->created_at,
        ];
    }
}
