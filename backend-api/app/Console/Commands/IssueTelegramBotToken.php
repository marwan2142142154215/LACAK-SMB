<?php

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;

/**
 * Menerbitkan Bearer token untuk akun layanan telegram-bot (lihat
 * TelegramBotAccountSeeder). Token lama (nama sama) dicabut dulu supaya
 * tidak ada token lama yang menggantung tanpa diketahui bot-nya sendiri.
 *
 * Token HANYA ditampilkan sekali di sini — operator menyalin ke
 * telegram-bot/.env (BACKEND_API_TOKEN), tidak pernah disimpan di tempat
 * lain (standar 6.1: kredensial sistem tidak boleh lewat chat/log).
 */
#[Signature('bot:issue-telegram-token')]
#[Description('Menerbitkan Bearer token baru untuk akun layanan telegram-bot')]
class IssueTelegramBotToken extends Command
{
    public function handle(): int
    {
        $bot = User::where('username', 'telegram-bot')->first();

        if (! $bot) {
            $this->error('Akun telegram-bot belum ada. Jalankan "php artisan db:seed" dulu.');

            return self::FAILURE;
        }

        $bot->tokens()->where('name', 'telegram-bot-service')->delete();

        $token = $bot->createToken('telegram-bot-service')->plainTextToken;

        $this->newLine();
        $this->line('Token berhasil dibuat. Salin ke telegram-bot/.env sebagai BACKEND_API_TOKEN:');
        $this->newLine();
        $this->line($token);
        $this->newLine();
        $this->warn('Token ini tidak akan ditampilkan lagi. Jangan dikirim lewat chat/WhatsApp.');

        return self::SUCCESS;
    }
}
