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
            'version' => ['nullable', 'string', 'max:20'],
        ];
    }
}
