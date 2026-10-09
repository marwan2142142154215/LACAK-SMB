<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

class FortuneSmbSuperAdminSeeder extends Seeder
{
    /**
     * Akun super_admin kedua untuk pengujian langsung oleh pemilik produk
     * (test APK master & web dashboard). Sama polanya dengan
     * InitialSuperAdminSeeder: two_factor_confirmed_at null supaya login
     * pertama memaksa enrollment 2FA.
     *
     * Password TIDAK ditulis di kode (repo ini publik): diambil dari env
     * FORTUNESMB_SUPERADMIN_PASSWORD, atau dibuat acak dan dicetak sekali ke konsol. Akun yang sudah ada
     * TIDAK disentuh -- reseed tidak boleh me-reset password/2FA, karena
     * itu membuka lagi jendela enrollment 2FA bagi siapa pun yang tahu
     * password-nya.
     */
    public function run(): void
    {
        $password = env('FORTUNESMB_SUPERADMIN_PASSWORD') ?: Str::password(20);
        $user = User::firstOrCreate(
            ['username' => 'fortunesmb'],
            [
                'organization_id' => null, // super_admin lintas site
                'name' => 'Fortune SMB',
                'email' => 'fortunesmb@lacaksmbbot.com',
                'password' => Hash::make($password),
                'is_active' => true,
                'two_factor_confirmed_at' => null,
                'two_factor_secret' => null,
                'two_factor_recovery_codes' => null,
            ]
        );

        if ($user->wasRecentlyCreated && ! env('FORTUNESMB_SUPERADMIN_PASSWORD')) {
            $this->command?->warn("Password awal fortunesmb: {$password} (simpan & ganti setelah login pertama)");
        }

        $user->assignRole('super_admin');
    }
}
