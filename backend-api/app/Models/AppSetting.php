<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Pengaturan sistem key-value (lihat migrasi create_app_settings_table).
 * Setiap perubahan tercatat di activity log beserta siapa yang mengubahnya.
 */
class AppSetting extends Model
{
    protected $primaryKey = 'key';

    protected $keyType = 'string';

    public $incrementing = false;

    protected $fillable = [
        'key',
        'value',
        'updated_by',
    ];

    public static function get(string $key, mixed $default = null): mixed
    {
        $setting = static::find($key);

        return $setting ? json_decode($setting->value, true) : $default;
    }

    public static function put(string $key, mixed $value, ?User $updatedBy = null): void
    {
        $old = static::get($key);

        static::updateOrCreate(['key' => $key], [
            'value' => json_encode($value),
            'updated_by' => $updatedBy?->id,
        ]);

        // Dicatat manual, bukan lewat trait LogsActivity: subject_id di
        // activity_log bertipe bigint, sedangkan primary key tabel ini teks.
        activity('app_settings')
            ->causedBy($updatedBy)
            ->withProperties(['key' => $key, 'old' => $old, 'new' => $value])
            ->log("Pengaturan {$key} diubah");
    }
}
