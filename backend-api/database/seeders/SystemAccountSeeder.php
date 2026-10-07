<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

class SystemAccountSeeder extends Seeder
{
    /**
     * Akun "pelaku" tercatat untuk aksi otomatis server (mis. auto-lock saat
     * device melewati jarak maksimum geofence, lihat realtime-gateway
     * app/services/geofence_evaluator.ts). is_active=false -> tidak bisa
     * dipakai login manusia lewat AuthController, tapi tetap valid sebagai
     * foreign key device_commands.issued_by untuk audit trail yang jujur
     * (bukan dicatat atas nama admin yang tidak benar-benar menekan tombol).
     */
    public function run(): void
    {
        User::updateOrCreate(
            ['username' => 'system-automation'],
            [
                'organization_id' => null,
                'name' => 'System Automation',
                'email' => 'system-automation@lacak.local',
                'password' => Hash::make(Str::random(40)),
                'is_active' => false,
                'two_factor_confirmed_at' => now(),
            ]
        );
    }
}
