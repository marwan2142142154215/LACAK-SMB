<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Mode BLE untuk aturan geofence: alih-alih titik pusat GPS (tidak presisi,
 * bisa meleset puluhan-ratusan meter di dalam ruangan), aturan bisa menunjuk
 * SATU device terdaftar sebagai "anchor" -- device referensi diam di lokasi
 * (HP bekas/spare yang APK Lacak-nya dipasang & dibiarkan menyala di site).
 * Device lain dalam radius BLE dari anchor itu (dibaca lewat RSSI, presisi
 * beberapa meter) dianggap aman; di luar jangkauan -> dikunci otomatis.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('geofence_rules', function (Blueprint $table) {
            $table->foreignId('anchor_device_id')->nullable()->after('center_longitude')
                ->constrained('devices')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('geofence_rules', function (Blueprint $table) {
            $table->dropConstrainedForeignId('anchor_device_id');
        });
    }
};
