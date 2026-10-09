<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

class InitialSuperAdminSeeder extends Seeder
{
    /**
     * Akun super_admin awal sesuai permintaan setup.
     * two_factor_confirmed_at sengaja dibiarkan null agar login pertama
     * memaksa alur enrollment 2FA (lihat AuthController::login).
     *
     * Password TIDAK ditulis di kode (repo ini publik): diambil dari env
     * INITIAL_SUPERADMIN_PASSWORD, atau dibuat acak dan dicetak sekali ke konsol. Akun yang sudah ada
     * TIDAK disentuh -- reseed tidak boleh me-reset password/2FA, karena
     * itu membuka lagi jendela enrollment 2FA bagi siapa pun yang tahu
     * password-nya.
     */
    public function run(): void
    {
        $password = env('INITIAL_SUPERADMIN_PASSWORD') ?: Str::password(20);
        $user = User::firstOrCreate(
            ['username' => 'marwanmaster'],
            [
                'organization_id' => null, // super_admin lintas site
                'name' => 'Marwan Master',
                'email' => 'marwanyahabibi@gmail.com',
                'password' => Hash::make($password),
                'is_active' => true,
                'two_factor_confirmed_at' => null,
                'two_factor_secret' => null,
                'two_factor_recovery_codes' => null,
            ]
        );

        if ($user->wasRecentlyCreated && ! env('INITIAL_SUPERADMIN_PASSWORD')) {
            $this->command?->warn("Password awal marwanmaster: {$password} (simpan & ganti setelah login pertama)");
        }

        $user->assignRole('super_admin');
    }
}
