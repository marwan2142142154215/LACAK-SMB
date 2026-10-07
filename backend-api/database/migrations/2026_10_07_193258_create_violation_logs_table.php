<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('violation_logs', function (Blueprint $table) {
            $table->id();
            $table->foreignId('device_id')->constrained('devices')->cascadeOnDelete();
            $table->foreignId('geofence_rule_id')->nullable()->constrained('geofence_rules')->nullOnDelete();
            $table->enum('violation_type', ['wifi_mismatch', 'ip_mismatch', 'distance_exceeded']);
            $table->string('detected_value');
            $table->boolean('notified_telegram')->default(false);
            $table->boolean('notified_dashboard')->default(false);
            $table->timestamp('detected_at');
            $table->timestamp('created_at')->useCurrent();

            $table->index(['device_id', 'detected_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('violation_logs');
    }
};
