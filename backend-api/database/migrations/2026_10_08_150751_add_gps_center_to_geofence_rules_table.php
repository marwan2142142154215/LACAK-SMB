<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Akar masalah "device gak kekunci walau sudah jauh dari batas": aturan
 * geofence HANYA punya max_distance_meters, dibandingkan terhadap
 * ble_distance_meters -- yang device SELALU kirim null, karena tracker app
 * cuma MEMANCARKAN beacon BLE (lihat BleBeaconAdvertiser), tidak pernah
 * men-SCAN jarak dari anchor manapun (tidak ada hardware anchor BLE di
 * sistem ini). Jadi cek jarak BLE itu tidak pernah bisa nyala sendiri.
 *
 * GPS lat/lng sebaliknya SUDAH dikirim device tiap heartbeat (30 detik) --
 * jadi titik pusat (center) di sini dipakai untuk geofence radius berbasis
 * GPS sungguhan, yang BISA otomatis aktif tanpa hardware tambahan apa pun.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('geofence_rules', function (Blueprint $table) {
            $table->decimal('center_latitude', 10, 7)->nullable()->after('max_distance_meters');
            $table->decimal('center_longitude', 10, 7)->nullable()->after('center_latitude');
        });
    }

    public function down(): void
    {
        Schema::table('geofence_rules', function (Blueprint $table) {
            $table->dropColumn(['center_latitude', 'center_longitude']);
        });
    }
};
