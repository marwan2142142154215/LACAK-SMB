<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class GenerateApkBuildRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('apk-builds.manage');
    }

    public function rules(): array
    {
        return [
            'organization_id' => ['required', 'integer', 'exists:organizations,id'],
            'apk_type' => ['required', Rule::in(['tracker', 'master', 'server'])],
            // Ketat ke pola semver (1.2.3 atau 1.2) -- nilai ini diteruskan ke
            // skrip build Gradle lewat WSL (App\Services\ApkBuilder), jadi
            // tidak boleh mengandung karakter shell apa pun.
            'version' => ['nullable', 'string', 'max:20', 'regex:/^\d{1,5}(\.\d{1,5}){1,2}$/'],
        ];
    }
}
