<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Tabel-tabel ini awalnya hanya punya created_at, padahal standar mewajibkan
 * created_at + updated_at di setiap tabel. Kolom dibuat nullable dengan
 * default CURRENT_TIMESTAMP supaya insert dari realtime-gateway versi lama
 * (yang belum mengisi updated_at) tetap lolos.
 */
return new class extends Migration
{
    /**
     * @var list<string>
     */
    private const TABLES = [
        'device_locations',
        'violation_logs',
        'device_commands',
        'device_otps',
        'apk_builds',
    ];

    public function up(): void
    {
        foreach (self::TABLES as $tableName) {
            Schema::table($tableName, function (Blueprint $table) {
                $table->timestamp('updated_at')->nullable()->useCurrent();
            });

            // Baris lama diberi updated_at = created_at, bukan waktu migration dijalankan,
            // supaya tidak terlihat seolah-olah semuanya baru saja diubah.
            DB::table($tableName)->update(['updated_at' => DB::raw('created_at')]);
        }
    }

    public function down(): void
    {
        foreach (self::TABLES as $tableName) {
            Schema::table($tableName, function (Blueprint $table) {
                $table->dropColumn('updated_at');
            });
        }
    }
};
