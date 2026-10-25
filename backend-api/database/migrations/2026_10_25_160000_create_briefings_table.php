<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Briefing: rapat video Live (room LiveKit briefing-{id}). Pemimpin (leader,
 * admin, root) memilih peran & site yang boleh bergabung; hanya user yang
 * cocok dengan keduanya yang mendapat token. Dikelola backend-adonis
 * (app/controllers/briefings_controller.ts).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('briefings', function (Blueprint $table) {
            $table->id();
            $table->string('title', 120);
            $table->foreignId('host_user_id')->constrained('users')->cascadeOnDelete();
            $table->json('allowed_roles');
            // Kosong = semua site (hanya root yang bisa memilih ini).
            $table->json('allowed_organization_ids');
            $table->timestamp('started_at');
            $table->timestamp('ended_at')->nullable();
            $table->timestamps();

            $table->index('ended_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('briefings');
    }
};
