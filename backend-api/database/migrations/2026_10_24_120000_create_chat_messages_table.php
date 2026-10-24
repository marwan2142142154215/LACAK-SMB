<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Chat staf per site (floating chat di dashboard). Pesan dikirim realtime
 * lewat realtime-gateway, tapi selalu disimpan & diotorisasi di sini --
 * gateway meneruskan POST /chat/messages dengan token user itu sendiri.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('chat_messages', function (Blueprint $table) {
            $table->id();
            $table->foreignId('organization_id')->constrained('organizations')->cascadeOnDelete();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->text('body');
            $table->timestamps();

            // Riwayat dimuat per site, terbaru dulu, dipaginasi dengan before_id.
            $table->index(['organization_id', 'id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('chat_messages');
    }
};
