<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('consent_documents', function (Blueprint $table) {
            $table->id();
            $table->foreignId('organization_id')->constrained('organizations')->cascadeOnDelete();
            $table->string('subject_name');
            $table->string('signer_name');
            $table->enum('signer_role', ['parent', 'hr_staff', 'device_owner']);
            // Path relatif di DigitalOcean Spaces, bukan URL lengkap (standar 6.3).
            $table->string('document_file_path');
            $table->date('signed_at');
            $table->date('valid_until')->nullable();
            $table->timestamp('revoked_at')->nullable();
            $table->foreignId('created_by')->constrained('users');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('consent_documents');
    }
};
