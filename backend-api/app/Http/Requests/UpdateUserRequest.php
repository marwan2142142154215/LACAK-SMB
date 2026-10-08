<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class UpdateUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('users.manage');
    }

    public function rules(): array
    {
        return [
            'name' => ['sometimes', 'string', 'max:255'],
            'email' => ['sometimes', 'email', 'max:255', Rule::unique('users', 'email')->ignore($this->route('user'))],
            'password' => ['sometimes', 'string', 'min:8'],
            'role' => ['sometimes', Rule::in(['admin', 'leader', 'site_admin', 'staff_viewer'])],
            'organization_id' => ['sometimes', 'nullable', 'integer', 'exists:organizations,id'],
        ];
    }
}
