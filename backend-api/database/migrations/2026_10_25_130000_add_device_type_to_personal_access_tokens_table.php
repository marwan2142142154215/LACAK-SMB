<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Perangkat tempat token login dipakai: 'computer' atau 'phone' (lihat
 * AuthController::loginDeviceOf). Ditampilkan sebagai ikon laptop/HP di
 * daftar staf. Null = token akun layanan atau token lama sebelum kolom ini.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('personal_access_tokens', function (Blueprint $table) {
            $table->string('device_type', 16)->nullable()->after('name');
        });
    }

    public function down(): void
    {
        Schema::table('personal_access_tokens', function (Blueprint $table) {
            $table->dropColumn('device_type');
        });
    }
};
