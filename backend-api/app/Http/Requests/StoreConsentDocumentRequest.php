<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreConsentDocumentRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('consent-documents.manage');
    }

    public function rules(): array
    {
        return [
            'organization_id' => ['required', 'integer', 'exists:organizations,id'],
            'subject_name' => ['required', 'string', 'max:255'],
            'signer_name' => ['required', 'string', 'max:255'],
            'signer_role' => ['required', Rule::in(['parent', 'hr_staff', 'device_owner'])],
            // File dokumen bertanda tangan: PDF atau foto scan, maks 10MB (standar 6.3).
            'document_file' => ['required', 'file', 'mimes:pdf,jpg,jpeg,png', 'max:10240'],
            'signed_at' => ['required', 'date'],
            'valid_until' => ['nullable', 'date', 'after:signed_at'],
        ];
    }
}
