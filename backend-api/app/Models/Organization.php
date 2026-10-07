<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;
use Spatie\Activitylog\LogOptions;
use Spatie\Activitylog\Traits\LogsActivity;

class Organization extends Model
{
    use HasFactory, LogsActivity, SoftDeletes;

    protected $fillable = [
        'name',
        'type',
        'unique_site_code',
        'is_active',
        'created_by',
        'updated_by',
    ];

    protected $casts = [
        'is_active' => 'boolean',
    ];

    public function users(): HasMany
    {
        return $this->hasMany(User::class);
    }

    public function devices(): HasMany
    {
        return $this->hasMany(Device::class);
    }

    public function consentDocuments(): HasMany
    {
        return $this->hasMany(ConsentDocument::class);
    }

    public function geofenceRules(): HasMany
    {
        return $this->hasMany(GeofenceRule::class);
    }

    public function apkBuilds(): HasMany
    {
        return $this->hasMany(ApkBuild::class);
    }

    public function telegramBindings(): HasMany
    {
        return $this->hasMany(TelegramBinding::class);
    }

    public function getActivitylogOptions(): LogOptions
    {
        return LogOptions::defaults()
            ->logOnly(['name', 'type', 'unique_site_code', 'is_active'])
            ->logOnlyDirty();
    }
}
