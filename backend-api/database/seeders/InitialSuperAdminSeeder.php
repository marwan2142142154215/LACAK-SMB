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
     * SENGAJA tidak ada password literal di sini -- sebelumnya ada, dan
     * karena repo ini ada di GitHub, siapa pun yang baca source bisa login
     * jadi super_admin (lihat laporan security review). Password sekarang
     * diambil dari env SEED_MARWANMASTER_PASSWORD kalau diisi, atau
     * digenerate acak lalu dicetak SEKALI ke output console db:seed --
     * tidak pernah tersimpan di kode maupun log lain.
     *
     * SENGAJA firstOrCreate, BUKAN updateOrCreate -- updateOrCreate dulu
     * membuat setiap `db:seed` ulang (termasuk tidak sengaja) menimpa
     * balik password & status 2FA akun ini ke nilai seed, menghapus
     * password yang sudah diganti user lewat dashboard.
     */
    public function run(): void
    {
        if (User::where('username', 'marwanmaster')->exists()) {
            return;
        }

        $password = env('SEED_MARWANMASTER_PASSWORD') ?: Str::password(20);

        User::create([
            'username' => 'marwanmaster',
            'organization_id' => null, // super_admin lintas site
            'name' => 'Marwan Master',
            'email' => 'marwanyahabibi@gmail.com',
            'password' => Hash::make($password),
            'is_active' => true,
            'two_factor_confirmed_at' => null,
            'two_factor_secret' => null,
            'two_factor_recovery_codes' => null,
        ])->assignRole('super_admin');

        if (! env('SEED_MARWANMASTER_PASSWORD')) {
            $this->command?->warn("Password awal marwanmaster (simpan sekarang, tidak akan ditampilkan lagi): {$password}");
        }
    }
}
