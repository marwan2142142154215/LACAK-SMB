<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Izin akses lintas-site eksplisit: role 'admin' dan 'leader' TIDAK terkunci
 * ke satu organization_id (beda dari site_admin/staff_viewer lama) -- mereka
 * cuma boleh melihat data site yang super_admin berikan izinnya secara
 * eksplisit di sini, bisa lebih dari satu site sekaligus.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('user_site_access', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignId('organization_id')->constrained('organizations')->cascadeOnDelete();
            $table->foreignId('granted_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();

            $table->unique(['user_id', 'organization_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('user_site_access');
    }
};
