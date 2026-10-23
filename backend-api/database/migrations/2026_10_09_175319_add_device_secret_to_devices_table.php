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
        Schema::table('devices', function (Blueprint $table) {
            // Nullable dengan sengaja -- device lama yang sudah terhubung
            // lewat APK versi sebelumnya belum punya ini, gateway tetap
            // menerima device:hello dari mereka TANPA secret (mode lama,
            // satu-satunya cara supaya migrasi ini tidak langsung memutus
            // semua device yang sedang aktif). Baru WAJIB begitu device
            // itu dipasangkan ulang lewat alur pairing OTP baru (lihat
            // DeviceOtpController::pair) yang mengisi kolom ini.
            $table->string('device_secret')->nullable()->after('device_uuid');
        });
    }

    public function down(): void
    {
        Schema::table('devices', function (Blueprint $table) {
            $table->dropColumn('device_secret');
        });
    }
};
