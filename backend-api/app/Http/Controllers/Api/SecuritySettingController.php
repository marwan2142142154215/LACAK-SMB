<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Responses\ApiResponse;
use App\Support\TwoFactorPolicy;
use Illuminate\Http\Request;

/**
 * Pengaturan keamanan sistem yang bisa diubah dari dashboard -- hanya
 * pemegang permission security.manage (super_admin).
 */
class SecuritySettingController extends Controller
{
    use ApiResponse;

    public function show(Request $request)
    {
        $request->user()->can('security.manage') || abort(403);

        return $this->success('Pengaturan keamanan', [
            'two_factor_required' => TwoFactorPolicy::isRequired(),
        ]);
    }

    public function update(Request $request)
    {
        $request->user()->can('security.manage') || abort(403);

        $data = $request->validate([
            'two_factor_required' => ['required', 'boolean'],
        ]);

        TwoFactorPolicy::setRequired($data['two_factor_required'], $request->user());

        return $this->success(
            $data['two_factor_required'] ? '2FA kembali wajib saat login' : '2FA dimatikan: login cukup dengan password',
            ['two_factor_required' => TwoFactorPolicy::isRequired()],
        );
    }
}
