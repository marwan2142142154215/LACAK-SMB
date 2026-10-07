<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('device_commands', function (Blueprint $table) {
            $table->id();
            $table->foreignId('device_id')->constrained('devices')->cascadeOnDelete();
            $table->enum('command_type', ['lock', 'unlock', 'start_monitor', 'stop_monitor', 'locate_now']);
            // NOT NULL dengan sengaja: setiap lock/unlock wajib bisa dipertanggungjawabkan ke satu akun.
            $table->foreignId('issued_by')->constrained('users');
            // system_auto: perintah otomatis server (mis. auto-lock saat melewati
            // jarak maksimum geofence) -> issued_by tetap wajib diisi, memakai
            // akun "system-automation" (lihat SystemAccountSeeder) agar tetap
            // ada jejak audit yang jujur, bukan atas nama admin manusia.
            $table->enum('issued_via', ['web_dashboard', 'master_app', 'telegram_bot', 'system_auto']);
            $table->enum('status', ['pending', 'delivered', 'acknowledged', 'failed'])->default('pending');
            $table->string('reason_note')->nullable();
            $table->timestamp('acknowledged_at')->nullable();
            $table->timestamp('created_at')->useCurrent();

            $table->index(['device_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('device_commands');
    }
};
