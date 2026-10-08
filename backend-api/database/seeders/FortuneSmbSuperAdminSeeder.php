<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

class FortuneSmbSuperAdminSeeder extends Seeder
{
    /**
     * Akun super_admin kedua untuk pengujian langsung oleh pemilik produk
     * (test APK master & web dashboard). Sama polanya dengan
     * InitialSuperAdminSeeder: two_factor_confirmed_at null supaya login
     * pertama memaksa enrollment 2FA.
     *
     * PENTING: ganti password ini lewat endpoint ganti password setelah
     * login pertama di lingkungan non-local / production.
     */
    public function run(): void
    {
        User::updateOrCreate(
            ['username' => 'fortunesmb'],
            [
                'organization_id' => null, // super_admin lintas site
                'name' => 'Fortune SMB',
                'email' => 'fortunesmb@lacaksmbbot.com',
                'password' => Hash::make('fortunesmb1'),
                'is_active' => true,
                'two_factor_confirmed_at' => null,
                'two_factor_secret' => null,
                'two_factor_recovery_codes' => null,
            ]
        )->assignRole('super_admin');
    }
}
