<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Spatie\Activitylog\LogOptions;
use Spatie\Activitylog\Traits\LogsActivity;

class GeofenceRule extends Model
{
    use HasFactory, LogsActivity;

    protected $fillable = [
        'organization_id',
        'rule_name',
        'allowed_ssid',
        'allowed_ip_cidr',
        'max_distance_meters',
        'center_latitude',
        'center_longitude',
        'anchor_device_id',
        'is_active',
        'created_by',
    ];

    protected $casts = [
        'is_active' => 'boolean',
    ];

    public function organization(): BelongsTo
    {
        return $this->belongsTo(Organization::class);
    }

    public function violationLogs(): HasMany
    {
        return $this->hasMany(ViolationLog::class);
    }

    public function anchorDevice(): BelongsTo
    {
        return $this->belongsTo(Device::class, 'anchor_device_id');
    }

    public function getActivitylogOptions(): LogOptions
    {
        return LogOptions::defaults()
            ->logOnly(['rule_name', 'allowed_ssid', 'allowed_ip_cidr', 'max_distance_meters', 'center_latitude', 'center_longitude', 'is_active'])
            ->logOnlyDirty();
    }
}
