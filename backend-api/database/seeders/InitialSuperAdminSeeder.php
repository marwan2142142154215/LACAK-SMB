<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

class InitialSuperAdminSeeder extends Seeder
{
    /**
     * Akun super_admin awal sesuai permintaan setup.
     * two_factor_confirmed_at sengaja dibiarkan null agar login pertama
     * memaksa alur enrollment 2FA (lihat AuthController::login).
     *
     * PENTING: ganti password ini lewat endpoint ganti password setelah
     * login pertama di lingkungan non-local / production.
     */
    public function run(): void
    {
        User::updateOrCreate(
            ['username' => 'marwanmaster'],
            [
                'organization_id' => null, // super_admin lintas site
                'name' => 'Marwan Master',
                'email' => 'marwanyahabibi@gmail.com',
                'password' => Hash::make('marwanmaster1'),
                'is_active' => true,
                'two_factor_confirmed_at' => null,
                'two_factor_secret' => null,
                'two_factor_recovery_codes' => null,
            ]
        )->assignRole('super_admin');
    }
}
