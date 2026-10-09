<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * device_uuid tidak rahasia (tampil di layar, dulu dipancarkan lewat BLE),
     * jadi gateway butuh rahasia per-device untuk mengautentikasi koneksi.
     * Yang disimpan hanya hash SHA-256 (hex) dari token acak 32 byte — token
     * asli cuma dikirim sekali ke device saat klaim enrollment.
     *
     * Nullable dengan sengaja: device yang terdaftar sebelum kolom ini ada
     * belum punya rahasia dan wajib didaftarkan ulang (gateway menolaknya).
     */
    public function up(): void
    {
        Schema::table('devices', function (Blueprint $table) {
            $table->string('secret_hash', 64)->nullable()->after('device_uuid');
        });
    }

    public function down(): void
    {
        Schema::table('devices', function (Blueprint $table) {
            $table->dropColumn('secret_hash');
        });
    }
};
