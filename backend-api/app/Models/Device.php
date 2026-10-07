<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;
use Spatie\Activitylog\LogOptions;
use Spatie\Activitylog\Traits\LogsActivity;

class Device extends Model
{
    use HasFactory, LogsActivity, SoftDeletes;

    protected $fillable = [
        'organization_id',
        'consent_document_id',
        'device_name',
        'device_uuid',
        'android_version',
        'app_build_version',
        'site_code_embedded',
        'status',
        'battery_level',
        'last_seen_at',
        'enrolled_at',
        'is_active',
        'created_by',
        'updated_by',
    ];

    protected $casts = [
        'last_seen_at' => 'datetime',
        'enrolled_at' => 'datetime',
        'is_active' => 'boolean',
    ];

    public function organization(): BelongsTo
    {
        return $this->belongsTo(Organization::class);
    }

    public function consentDocument(): BelongsTo
    {
        return $this->belongsTo(ConsentDocument::class);
    }

    public function locations(): HasMany
    {
        return $this->hasMany(DeviceLocation::class);
    }

    public function commands(): HasMany
    {
        return $this->hasMany(DeviceCommand::class);
    }

    public function otps(): HasMany
    {
        return $this->hasMany(DeviceOtp::class);
    }

    public function violationLogs(): HasMany
    {
        return $this->hasMany(ViolationLog::class);
    }

    public function latestLocation(): ?DeviceLocation
    {
        return $this->locations()->latest('recorded_at')->first();
    }

    public function getActivitylogOptions(): LogOptions
    {
        return LogOptions::defaults()
            ->logOnly(['device_name', 'status', 'is_active'])
            ->logOnlyDirty();
    }
}
