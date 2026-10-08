<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('users.manage');
    }

    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'username' => ['required', 'string', 'max:255', 'unique:users,username'],
            'email' => ['required', 'email', 'max:255', 'unique:users,email'],
            'password' => ['required', 'string', 'min:8'],
            // super_admin & telegram_bot_service SENGAJA tidak termasuk --
            // super_admin cuma dibuat lewat seeder, telegram_bot_service
            // satu-satunya dipegang akun layanan bot (lihat TelegramBotAccountSeeder).
            'role' => ['required', Rule::in(['admin', 'leader', 'site_admin', 'staff_viewer'])],
            // organization_id = site "rumah" staf ini (dipakai site_admin/staff_viewer).
            // admin/leader scoping-nya dari site_access, bukan field ini -- tetap boleh
            // diisi sebagai site utama/default tapi tidak membatasi akses mereka.
            'organization_id' => ['nullable', 'integer', 'exists:organizations,id'],
            'site_access' => ['nullable', 'array'],
            'site_access.*' => ['integer', 'exists:organizations,id'],
        ];
    }
}
