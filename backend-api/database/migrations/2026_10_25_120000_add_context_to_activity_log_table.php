<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Log aktivitas sistem (menu Log aktivitas): tiap catatan menyimpan site,
 * alamat IP, dan perangkat/browser pelakunya, supaya bisa disaring per site
 * dan ditelusuri dari mana sebuah aksi dilakukan.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('activity_log', function (Blueprint $table) {
            $table->foreignId('organization_id')->nullable()->after('batch_uuid')->constrained('organizations')->nullOnDelete();
            $table->string('ip_address', 45)->nullable()->after('organization_id');
            $table->string('user_agent', 255)->nullable()->after('ip_address');
            $table->index(['organization_id', 'id']);
            $table->index(['log_name', 'id']);
        });
    }

    public function down(): void
    {
        Schema::table('activity_log', function (Blueprint $table) {
            $table->dropIndex(['organization_id', 'id']);
            $table->dropIndex(['log_name', 'id']);
            $table->dropConstrainedForeignId('organization_id');
            $table->dropColumn(['ip_address', 'user_agent']);
        });
    }
};
