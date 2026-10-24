<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\Str;

/** Satu pesan di chat staf satu site (lihat ChatMessageController). */
class ChatMessage extends Model
{
    /** Tautan gambar bertanda tangan berlaku selama ini; riwayat dimuat ulang tiap membuka chat. */
    public const IMAGE_URL_HOURS = 12;

    protected $fillable = [
        'organization_id',
        'user_id',
        'reply_to_id',
        'body',
        'image_path',
        'image_mime',
        'image_width',
        'image_height',
    ];

    /** Path berkas tidak pernah dikirim ke klien -- hanya tautan bertanda tangan. */
    protected $hidden = ['image_path'];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function organization(): BelongsTo
    {
        return $this->belongsTo(Organization::class);
    }

    /** Pesan yang dibalas (null kalau bukan balasan, atau pesan aslinya sudah terhapus). */
    public function replyTo(): BelongsTo
    {
        return $this->belongsTo(self::class, 'reply_to_id');
    }

    public function imageUrl(): ?string
    {
        return $this->image_path
            ? URL::temporarySignedRoute('api.v1.chat-messages.image', now()->addHours(self::IMAGE_URL_HOURS), ['chatMessage' => $this->id])
            : null;
    }

    /**
     * @return array{id: int, organization_id: int, user_id: int, user_name: ?string, body: ?string, image: ?array{url: ?string, width: ?int, height: ?int}, reply_to: ?array{id: int, user_name: ?string, body: ?string, has_image: bool}, created_at: mixed}
     */
    public function toPayload(): array
    {
        $replyTo = $this->reply_to_id ? $this->replyTo : null;

        return [
            'id' => $this->id,
            'organization_id' => $this->organization_id,
            'user_id' => $this->user_id,
            'user_name' => $this->user?->name,
            'body' => $this->body,
            'image' => $this->image_path ? [
                'url' => $this->imageUrl(),
                'width' => $this->image_width,
                'height' => $this->image_height,
            ] : null,
            // Kutipan singkat pesan asal, cukup untuk ditampilkan di atas balasan.
            'reply_to' => $replyTo ? [
                'id' => $replyTo->id,
                'user_name' => $replyTo->user?->name,
                'body' => $replyTo->body !== null ? Str::limit($replyTo->body, 140) : null,
                'has_image' => $replyTo->image_path !== null,
            ] : null,
            'created_at' => $this->created_at,
        ];
    }
}
