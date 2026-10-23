<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Sesi "Mulai Kerja" -> "Selesai Kerja" untuk fitur Live Kerja. Selama sesi
 * terbuka, staf menyiarkan kamera ke room LiveKit site-nya. Tabel ini jadi
 * audit trail (siapa live, kapan, di site mana) -- video-nya sendiri TIDAK
 * direkam di mana pun.
 *
 * organization_id disalin saat sesi dibuka (bukan dibaca dari users saat
 * query) supaya riwayat tetap benar walau staf dipindah site belakangan.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('work_sessions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignId('organization_id')->constrained('organizations')->cascadeOnDelete();
            $table->timestamp('started_at');
            $table->timestamp('last_heartbeat_at');
            $table->timestamp('ended_at')->nullable();
            // manual = staf tekan "Selesai Kerja", timeout = heartbeat
            // berhenti (lihat work-sessions:close-stale).
            $table->string('end_reason', 20)->nullable();
            $table->timestamps();

            $table->index(['organization_id', 'ended_at']);
            $table->index(['ended_at', 'last_heartbeat_at']);
        });

        // Satu staf maksimal SATU sesi terbuka -- dijaga di level database
        // (partial unique index PostgreSQL), bukan cuma di controller, supaya
        // dua klik "Mulai Kerja" bersamaan dari dua tab tidak lolos dua-duanya.
        DB::statement('CREATE UNIQUE INDEX work_sessions_one_open_per_user ON work_sessions (user_id) WHERE ended_at IS NULL');
    }

    public function down(): void
    {
        Schema::dropIfExists('work_sessions');
    }
};
