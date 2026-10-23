<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Satukan dua model rahasia device hasil merge: devices.device_secret
     * (plaintext, dari pairing OTP / zero-touch versi lama) dipindah ke
     * devices.secret_hash (SHA-256 hex) lalu kolom plaintext-nya dibuang.
     * Device yang sudah dipasangkan tetap bisa login dengan rahasia yang sama,
     * karena gateway membandingkan SHA-256 dari rahasia yang dikirim.
     *
     * Alur pairing OTP digantikan klaim enrollment + daftar ulang, jadi kode
     * pairing yang tersisa dihapus dan purpose 'pairing' dikeluarkan lagi.
     */
    public function up(): void
    {
        if (Schema::hasColumn('devices', 'device_secret')) {
            DB::table('devices')
                ->whereNotNull('device_secret')
                ->whereNull('secret_hash')
                ->update(['secret_hash' => DB::raw("encode(sha256(convert_to(device_secret, 'UTF8')), 'hex')")]);

            Schema::table('devices', function (Blueprint $table) {
                $table->dropColumn('device_secret');
            });
        }

        DB::table('device_otps')->where('purpose', 'pairing')->delete();
        DB::statement('ALTER TABLE device_otps DROP CONSTRAINT IF EXISTS device_otps_purpose_check');
        DB::statement("ALTER TABLE device_otps ADD CONSTRAINT device_otps_purpose_check CHECK (purpose = 'self_unlock')");
    }

    /**
     * Hash tidak bisa dibalik ke plaintext, jadi down() hanya mengembalikan
     * struktur kolom; device yang sudah punya secret_hash tetap memakainya.
     */
    public function down(): void
    {
        Schema::table('devices', function (Blueprint $table) {
            $table->string('device_secret')->nullable()->after('device_uuid');
        });

        DB::statement('ALTER TABLE device_otps DROP CONSTRAINT IF EXISTS device_otps_purpose_check');
        DB::statement("ALTER TABLE device_otps ADD CONSTRAINT device_otps_purpose_check CHECK (purpose IN ('self_unlock', 'pairing'))");
    }
};
