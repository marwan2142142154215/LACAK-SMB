<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Live Kerja leader: leader bisa memegang beberapa site, jadi siarannya masuk
 * satu ruang leader global (room LiveKit "leaders"), bukan room site mana pun.
 * Sesi kerja leader disimpan dengan organization_id NULL.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement('ALTER TABLE work_sessions ALTER COLUMN organization_id DROP NOT NULL');
    }

    public function down(): void
    {
        DB::statement('DELETE FROM work_sessions WHERE organization_id IS NULL');
        DB::statement('ALTER TABLE work_sessions ALTER COLUMN organization_id SET NOT NULL');
    }
};
