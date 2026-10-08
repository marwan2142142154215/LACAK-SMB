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
            // telegram_bot_service tetap tidak termasuk -- satu-satunya akun
            // layanan bot (lihat TelegramBotAccountSeeder). super_admin BOLEH
            // dibuat lewat dashboard (Tambah Staf) oleh super_admin lain yang
            // punya users.manage -- memberi full akses semua fitur & semua site.
            'role' => ['required', Rule::in(['super_admin', 'admin', 'leader', 'site_admin', 'staff_viewer'])],
            // organization_id = site "rumah" staf ini (dipakai site_admin/staff_viewer).
            // admin/leader scoping-nya dari site_access, bukan field ini -- tetap boleh
            // diisi sebagai site utama/default tapi tidak membatasi akses mereka.
            'organization_id' => ['nullable', 'integer', 'exists:organizations,id'],
            'site_access' => ['nullable', 'array'],
            'site_access.*' => ['integer', 'exists:organizations,id'],
        ];
    }
}
