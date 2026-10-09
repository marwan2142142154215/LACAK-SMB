<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Tautan akun Telegram pribadi staf -> akun login staf itu di sistem.
     * Tanpa ini bot Telegram cuma tahu chat-nya milik site mana (lihat
     * telegram_bindings), TIDAK tahu siapa pengirim pesan sebenarnya --
     * jadi izinnya dipukul rata pakai permission akun layanan bot untuk
     * SEMUA orang di grup. Dengan tabel ini, bot bisa menegakkan izin
     * PER-ORANG seperti web dashboard & APK master (lihat
     * TelegramUserLinkController::lookup, dipakai telegram-bot).
     */
    public function up(): void
    {
        Schema::create('telegram_user_links', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            // ID numerik akun Telegram (bukan username, yang bisa berganti) --
            // dari ctx.from.id di sisi bot, didapat otomatis saat staf kirim
            // pesan, bukan diketik manual (anti salah ketik).
            $table->string('telegram_user_id')->unique();
            $table->string('telegram_username')->nullable();
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('telegram_user_links');
    }
};
