<?php

namespace App\Http\Resources;

use App\Models\ConsentDocument;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Facades\URL;

/** @mixin ConsentDocument */
class ConsentDocumentResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'organization_id' => $this->organization_id,
            'subject_name' => $this->subject_name,
            'signer_name' => $this->signer_name,
            'signer_role' => $this->signer_role,
            // Tautan bertanda waktu (standar 6.3) lewat route API sendiri, bukan URL
            // disk langsung — supaya tetap konsisten baik disk 'local' maupun 'spaces'.
            'document_url' => URL::temporarySignedRoute(
                'api.v1.consent-documents.download',
                now()->addMinutes(15),
                ['consentDocument' => $this->id]
            ),
            'signed_at' => $this->signed_at,
            'valid_until' => $this->valid_until,
            'revoked_at' => $this->revoked_at,
            'is_active' => $this->isActive(),
            'created_at' => $this->created_at,
        ];
    }
}
