<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Satu baris log kerja: login, mulai kerja, layar/kamera nyala-mati,
 * istirahat, terputus, logout. Lihat App\Services\WorkPresence.
 */
class WorkSessionEvent extends Model
{
    protected $fillable = [
        'user_id',
        'organization_id',
        'work_session_id',
        'type',
        'status',
        'occurred_at',
    ];

    protected $casts = [
        'occurred_at' => 'datetime',
    ];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
