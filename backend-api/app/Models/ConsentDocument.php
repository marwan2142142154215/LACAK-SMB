<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Spatie\Activitylog\LogOptions;
use Spatie\Activitylog\Traits\LogsActivity;

class ConsentDocument extends Model
{
    use HasFactory, LogsActivity;

    protected $fillable = [
        'organization_id',
        'subject_name',
        'signer_name',
        'signer_role',
        'document_file_path',
        'signed_at',
        'valid_until',
        'revoked_at',
        'created_by',
    ];

    protected $casts = [
        'signed_at' => 'date',
        'valid_until' => 'date',
        'revoked_at' => 'datetime',
    ];

    public function organization(): BelongsTo
    {
        return $this->belongsTo(Organization::class);
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    public function devices(): HasMany
    {
        return $this->hasMany(Device::class);
    }

    public function isActive(): bool
    {
        if ($this->revoked_at !== null) {
            return false;
        }

        if ($this->valid_until !== null && $this->valid_until->isPast()) {
            return false;
        }

        return true;
    }

    public function getActivitylogOptions(): LogOptions
    {
        return LogOptions::defaults()
            ->logOnly(['subject_name', 'signer_name', 'signer_role', 'revoked_at'])
            ->logOnlyDirty();
    }
}
