<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Status kerja staf selama sesi Live Kerja terbuka (kamera/layar menyala,
 * istirahat, idle) + log kejadiannya. Jam kerja aktual dihitung dari log ini
 * -- bukan cuma dari jam login atau jam "Mulai kerja".
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('work_sessions', function (Blueprint $table) {
            $table->boolean('camera_active')->default(false);
            $table->boolean('screen_active')->default(false);
            $table->boolean('on_break')->default(false);
            $table->boolean('idle')->default(false);
            // Diisi work-sessions:close-stale saat heartbeat telat, dikosongkan
            // lagi begitu heartbeat datang -- supaya kejadian "terputus" dan
            // "tersambung lagi" masing-masing tercatat sekali.
            $table->timestamp('disconnected_at')->nullable();
        });

        Schema::create('work_session_events', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            // Disalin saat kejadian, sama seperti work_sessions.organization_id.
            $table->foreignId('organization_id')->nullable()->constrained('organizations')->cascadeOnDelete();
            $table->foreignId('work_session_id')->nullable()->constrained('work_sessions')->nullOnDelete();
            $table->string('type', 30);
            // Status staf SETELAH kejadian ini (working, break, offline, ...).
            $table->string('status', 20);
            $table->timestamp('occurred_at');
            $table->timestamps();

            $table->index(['organization_id', 'occurred_at']);
            $table->index(['user_id', 'occurred_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('work_session_events');

        Schema::table('work_sessions', function (Blueprint $table) {
            $table->dropColumn(['camera_active', 'screen_active', 'on_break', 'idle', 'disconnected_at']);
        });
    }
};
