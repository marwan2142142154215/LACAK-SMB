<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

class DummyRootSeeder extends Seeder
{
    /**
     * Akun uji 'root' (super_admin) untuk pengembangan lokal. Tetap WAJIB 2FA
     * seperti akun lain: login pertama langsung masuk alur setup 2FA.
     *
     * SENGAJA tidak dijalankan di luar local. Password diambil dari env
     * ROOT_PASSWORD supaya tidak tertulis di kode (repo publik).
     */
    public function run(): void
    {
        if (! app()->environment('local')) {
            return;
        }

        $user = User::firstOrCreate(
            ['username' => 'root'],
            [
                'organization_id' => null,
                'name' => 'Root (uji lokal)',
                'email' => 'root@lacak.local',
                'password' => Hash::make(env('ROOT_PASSWORD', 'Root12345!')),
                'is_active' => true,
            ]
        );

        $user->assignRole('super_admin');
    }
}
