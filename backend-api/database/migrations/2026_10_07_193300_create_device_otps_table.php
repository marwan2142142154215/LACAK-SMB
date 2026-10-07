<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('device_otps', function (Blueprint $table) {
            $table->id();
            $table->foreignId('device_id')->constrained('devices')->cascadeOnDelete();
            // Selalu hash, tidak pernah plaintext meski OTP berumur pendek (standar 4.4 & 6.4).
            $table->string('otp_code_hash');
            $table->enum('purpose', ['self_unlock'])->default('self_unlock');
            $table->timestamp('expires_at');
            $table->timestamp('used_at')->nullable();
            $table->timestamp('created_at')->useCurrent();

            $table->index(['device_id', 'expires_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('device_otps');
    }
};
