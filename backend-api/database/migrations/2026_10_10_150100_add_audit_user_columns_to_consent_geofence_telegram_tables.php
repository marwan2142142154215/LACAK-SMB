<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Melengkapi jejak created_by/updated_by pada data penting. Nullable karena
 * baris yang sudah ada tidak punya catatan siapa pembuat/pengubahnya.
 */
return new class extends Migration
{
    /**
     * @var array<string, list<string>>
     */
    private const AUDIT_COLUMNS = [
        'consent_documents' => ['updated_by'],
        'geofence_rules' => ['updated_by'],
        'telegram_bindings' => ['created_by', 'updated_by'],
    ];

    public function up(): void
    {
        foreach (self::AUDIT_COLUMNS as $tableName => $columns) {
            Schema::table($tableName, function (Blueprint $table) use ($columns) {
                foreach ($columns as $column) {
                    $table->foreignId($column)->nullable()->index()->constrained('users');
                }
            });
        }
    }

    public function down(): void
    {
        foreach (self::AUDIT_COLUMNS as $tableName => $columns) {
            Schema::table($tableName, function (Blueprint $table) use ($columns) {
                foreach ($columns as $column) {
                    $table->dropConstrainedForeignId($column);
                }
            });
        }
    }
};
