<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('devices', function (Blueprint $table) {
            $table->id();
            $table->foreignId('organization_id')->constrained('organizations')->cascadeOnDelete();
            // NOT NULL dengan sengaja: device tidak boleh ada tanpa consent yang sah (lihat docs/skema-database.md).
            $table->foreignId('consent_document_id')->constrained('consent_documents');
            $table->string('device_name');
            $table->string('device_uuid')->unique();
            $table->string('android_version', 10);
            $table->string('app_build_version', 20);
            $table->string('site_code_embedded', 32);
            $table->enum('status', ['online', 'offline', 'locked', 'pending_enrollment'])->default('pending_enrollment');
            $table->unsignedTinyInteger('battery_level')->nullable();
            $table->timestamp('last_seen_at')->nullable();
            $table->timestamp('enrolled_at')->nullable();
            $table->boolean('is_active')->default(true);
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignId('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
            $table->softDeletes();

            $table->index('status');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('devices');
    }
};
