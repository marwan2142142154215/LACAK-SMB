<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

class TelegramBotAccountSeeder extends Seeder
{
    /**
     * Akun layanan untuk bot Telegram (telegram-bot/ Node.js). is_active
     * sengaja false -> tidak bisa login manusia lewat AuthController (2FA
     * tidak bisa diselesaikan bot secara interaktif). Token akses dibuat
     * terpisah lewat `php artisan bot:issue-telegram-token` (lihat
     * IssueTelegramBotToken), bukan lewat alur login biasa.
     */
    public function run(): void
    {
        User::updateOrCreate(
            ['username' => 'telegram-bot'],
            [
                'organization_id' => null,
                'name' => 'Telegram Bot Service',
                'email' => 'telegram-bot@lacak.local',
                'password' => Hash::make(Str::random(40)),
                'is_active' => false,
                'two_factor_confirmed_at' => now(),
            ]
        )->syncRoles(['telegram_bot_service']);
    }
}
