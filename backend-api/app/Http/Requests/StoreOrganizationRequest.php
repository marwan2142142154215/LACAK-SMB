<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class StoreOrganizationRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('organizations.manage');
    }

    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'type' => ['required', Rule::in(['company_asset', 'family_parental'])],
        ];
    }

    /**
     * Kode unik site dibuat server-side, tidak diisi manual, agar tidak bisa
     * ditebak/diduplikasi (dipakai untuk menandai APK pelacak per site).
     */
    public function generatedSiteCode(): string
    {
        return 'SITE-'.strtoupper(Str::random(10));
    }
}
