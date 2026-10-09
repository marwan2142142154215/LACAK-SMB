<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * PostgreSQL tidak membuat indeks otomatis untuk kolom foreign key, sehingga
 * join, filter per organisasi, dan ON DELETE CASCADE/SET NULL dari tabel induk
 * berujung sequential scan. Kolom FK yang sudah tercakup sebagai kolom pertama
 * indeks/unique/primary lain (mis. device_id pada device_locations,
 * user_id pada user_site_access) sengaja tidak diindeks ulang.
 */
return new class extends Migration
{
    /**
     * @var array<string, list<string>>
     */
    private const FOREIGN_KEY_COLUMNS = [
        'consent_documents' => ['organization_id', 'created_by'],
        'devices' => ['organization_id', 'consent_document_id', 'created_by', 'updated_by'],
        'geofence_rules' => ['organization_id', 'created_by', 'anchor_device_id'],
        'violation_logs' => ['geofence_rule_id'],
        'device_commands' => ['issued_by'],
        'apk_builds' => ['organization_id', 'built_by'],
        'telegram_bindings' => ['organization_id'],
        'user_site_access' => ['organization_id', 'granted_by'],
    ];

    public function up(): void
    {
        foreach (self::FOREIGN_KEY_COLUMNS as $tableName => $columns) {
            Schema::table($tableName, function (Blueprint $table) use ($columns) {
                foreach ($columns as $column) {
                    $table->index($column);
                }
            });
        }

        // role_id bukan kolom pertama primary key (permission_id, role_id), jadi belum terindeks.
        Schema::table($this->roleHasPermissionsTable(), function (Blueprint $table) {
            $table->index($this->rolePivotKey());
        });
    }

    public function down(): void
    {
        Schema::table($this->roleHasPermissionsTable(), function (Blueprint $table) {
            $table->dropIndex([$this->rolePivotKey()]);
        });

        foreach (self::FOREIGN_KEY_COLUMNS as $tableName => $columns) {
            Schema::table($tableName, function (Blueprint $table) use ($columns) {
                foreach ($columns as $column) {
                    $table->dropIndex([$column]);
                }
            });
        }
    }

    private function roleHasPermissionsTable(): string
    {
        return config('permission.table_names.role_has_permissions', 'role_has_permissions');
    }

    private function rolePivotKey(): string
    {
        return config('permission.column_names.role_pivot_key') ?? 'role_id';
    }
};
