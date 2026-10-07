<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ViolationLog extends Model
{
    use HasFactory;

    public $timestamps = false;

    protected $fillable = [
        'device_id',
        'geofence_rule_id',
        'violation_type',
        'detected_value',
        'notified_telegram',
        'notified_dashboard',
        'detected_at',
    ];

    protected $casts = [
        'notified_telegram' => 'boolean',
        'notified_dashboard' => 'boolean',
        'detected_at' => 'datetime',
        'created_at' => 'datetime',
    ];

    public function device(): BelongsTo
    {
        return $this->belongsTo(Device::class);
    }

    public function geofenceRule(): BelongsTo
    {
        return $this->belongsTo(GeofenceRule::class);
    }
}
