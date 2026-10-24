<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Satu pesan di chat staf satu site (lihat ChatMessageController). */
class ChatMessage extends Model
{
    protected $fillable = [
        'organization_id',
        'user_id',
        'body',
    ];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function organization(): BelongsTo
    {
        return $this->belongsTo(Organization::class);
    }

    /** @return array{id: int, organization_id: int, user_id: int, user_name: ?string, body: string, created_at: mixed} */
    public function toPayload(): array
    {
        return [
            'id' => $this->id,
            'organization_id' => $this->organization_id,
            'user_id' => $this->user_id,
            'user_name' => $this->user?->name,
            'body' => $this->body,
            'created_at' => $this->created_at,
        ];
    }
}
