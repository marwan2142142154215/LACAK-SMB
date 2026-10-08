<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('apk_builds', function (Blueprint $table) {
            // tracker = APK device-target (lihat android-tracked-app), master
            // = APK admin/staf lapangan (lihat android-master-app). Baris lama
            // (upload manual sebelum fitur ini ada) semuanya tracker.
            $table->string('apk_type', 10)->default('tracker')->after('organization_id');

            // Build sekarang dipicu server (Gradle lewat WSL2) dan butuh
            // waktu nyata (~30-90 detik) -- status dipakai supaya dashboard
            // /bot Telegram/APK master bisa menunjukkan progres & kegagalan
            // build dengan jujur, bukan berasumsi selalu sukses.
            $table->string('status', 10)->default('success')->after('version');
            $table->text('build_log')->nullable()->after('checksum_sha256');

            $table->index('apk_type');
            $table->index('status');
        });

        // file_path & checksum kosong untuk baris 'building'/'failed' (belum
        // ada file) -- kolom lama tidak nullable, longgarkan lewat SQL mentah
        // (doctrine/dbal tidak ter-install, jadi ->change() tidak bisa dipakai).
        DB::statement('ALTER TABLE apk_builds ALTER COLUMN file_path DROP NOT NULL');
        DB::statement('ALTER TABLE apk_builds ALTER COLUMN checksum_sha256 DROP NOT NULL');
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        DB::statement("UPDATE apk_builds SET file_path = '' WHERE file_path IS NULL");
        DB::statement("UPDATE apk_builds SET checksum_sha256 = '' WHERE checksum_sha256 IS NULL");
        DB::statement('ALTER TABLE apk_builds ALTER COLUMN file_path SET NOT NULL');
        DB::statement('ALTER TABLE apk_builds ALTER COLUMN checksum_sha256 SET NOT NULL');

        Schema::table('apk_builds', function (Blueprint $table) {
            $table->dropIndex(['apk_type']);
            $table->dropIndex(['status']);
            $table->dropColumn(['apk_type', 'status', 'build_log']);
        });
    }
};
