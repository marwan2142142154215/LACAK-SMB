<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('apk_builds', function (Blueprint $table) {
            $table->id();
            $table->foreignId('organization_id')->constrained('organizations')->cascadeOnDelete();
            $table->string('version', 20);
            $table->string('file_path');
            $table->string('embedded_site_code', 32);
            // Dicek oleh APK saat start; checksum beda untuk kode site yang sama -> APK menolak jalan.
            $table->string('checksum_sha256', 64);
            $table->foreignId('built_by')->constrained('users');
            $table->timestamp('created_at')->useCurrent();

            $table->index('embedded_site_code');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('apk_builds');
    }
};
