<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Tambah 'pairing' ke CHECK constraint kolom purpose (sebelumnya cuma
     * 'self_unlock') -- dipakai alur pairing device_secret baru
     * (DeviceOtpController::pair, lihat security review Vuln 5: identitas
     * device sebelumnya cuma device_uuid+siteCode yang tidak rahasia).
     */
    public function up(): void
    {
        DB::statement('ALTER TABLE device_otps DROP CONSTRAINT device_otps_purpose_check');
        DB::statement("ALTER TABLE device_otps ADD CONSTRAINT device_otps_purpose_check CHECK (purpose IN ('self_unlock', 'pairing'))");
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE device_otps DROP CONSTRAINT device_otps_purpose_check');
        DB::statement("ALTER TABLE device_otps ADD CONSTRAINT device_otps_purpose_check CHECK (purpose = 'self_unlock')");
    }
};
