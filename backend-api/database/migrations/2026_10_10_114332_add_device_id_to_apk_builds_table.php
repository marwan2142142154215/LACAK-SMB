<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('apk_builds', function (Blueprint $table) {
            // Nullable -- cuma diisi untuk apk_type='tracker' (identitas
            // zero-touch per device, lihat ApkBuildController::generate).
            // Build 'master'/'server' tidak terikat satu device, tetap null.
            // nullOnDelete: riwayat build tetap ada kalau device-nya dihapus
            // belakangan, cuma tautannya lepas.
            $table->foreignId('device_id')->nullable()->after('organization_id')
                ->constrained('devices')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('apk_builds', function (Blueprint $table) {
            $table->dropConstrainedForeignId('device_id');
        });
    }
};
