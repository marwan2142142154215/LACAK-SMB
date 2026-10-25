<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Rekaman Live Kerja: satu baris = satu file video (kamera ATAU layar satu
 * staf, dipotong per jam) yang direkam LiveKit Egress langsung ke
 * DigitalOcean Spaces. Dikelola backend-adonis (app/services/recording.ts);
 * file & barisnya dihapus otomatis setelah masa simpan (72 jam).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('live_recordings', function (Blueprint $table) {
            $table->id();
            $table->foreignId('organization_id')->constrained('organizations')->cascadeOnDelete();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignId('work_session_id')->nullable()->constrained('work_sessions')->nullOnDelete();
            $table->string('egress_id')->unique();
            $table->string('track_sid');
            $table->string('source', 20); // camera | screen_share
            $table->string('status', 20)->default('recording'); // recording | rotating | completed | failed
            $table->string('file_path')->nullable();
            $table->unsignedBigInteger('size_bytes')->nullable();
            $table->text('error')->nullable();
            $table->timestamp('started_at');
            $table->timestamp('ended_at')->nullable();
            $table->timestamps();

            $table->index(['user_id', 'started_at']);
            $table->index(['organization_id', 'started_at']);
            $table->index(['status', 'started_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('live_recordings');
    }
};
