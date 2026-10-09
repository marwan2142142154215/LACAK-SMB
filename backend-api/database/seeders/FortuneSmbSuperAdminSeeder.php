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
     * (test APK master & web dashboard). Sama alasannya dengan
     * InitialSuperAdminSeeder: tidak ada password literal di kode, firstOrCreate
     * (bukan updateOrCreate) supaya reseed tidak menimpa password yang sudah
     * diganti user.
     */
    public function run(): void
    {
        if (User::where('username', 'fortunesmb')->exists()) {
            return;
        }

        $password = env('SEED_FORTUNESMB_PASSWORD') ?: Str::password(20);

        User::create([
            'username' => 'fortunesmb',
            'organization_id' => null, // super_admin lintas site
            'name' => 'Fortune SMB',
            'email' => 'fortunesmb@lacaksmbbot.com',
            'password' => Hash::make($password),
            'is_active' => true,
            'two_factor_confirmed_at' => null,
            'two_factor_secret' => null,
            'two_factor_recovery_codes' => null,
        ])->assignRole('super_admin');

        if (! env('SEED_FORTUNESMB_PASSWORD')) {
            $this->command?->warn("Password awal fortunesmb (simpan sekarang, tidak akan ditampilkan lagi): {$password}");
        }
    }
}
