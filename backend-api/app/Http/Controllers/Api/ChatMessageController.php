<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Responses\ApiResponse;
use App\Models\ChatMessage;
use App\Support\ResolvesOrganizationScope;
use App\Support\ServesDocumentsDiskFiles;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Throwable;

/**
 * Chat staf per site. Satu ruang chat = satu site; siapa yang boleh membaca
 * & menulis memakai aturan yang sama dengan Live Kerja (live.watch +
 * ResolvesOrganizationScope): staf hanya site-nya sendiri, admin/leader
 * site yang diberikan, super_admin semua site.
 *
 * Realtime-gateway memanggil endpoint ini dengan token user yang sedang
 * chat (bukan token sistem), jadi gateway tidak pernah memutuskan sendiri
 * siapa boleh masuk ruang chat mana. Gambar disimpan di disk
 * filesystems.chat_images_disk (bawaan: disk lokal privat). Pesan bergambar dikirim dashboard
 * langsung ke sini (multipart), lalu gateway mengambil pesan jadi lewat
 * show() sebelum menyiarkannya -- isi siaran selalu dari backend.
 */
class ChatMessageController extends Controller
{
    use ApiResponse, ResolvesOrganizationScope, ServesDocumentsDiskFiles;

    private const PAGE_SIZE = 50;

    /** Batas ukuran gambar (KB); dashboard sudah mengecilkan foto sebelum mengunggah. */
    private const MAX_IMAGE_KB = 5120;

    /** Riwayat pesan terbaru (urut lama -> baru); before_id untuk memuat yang lebih lama. */
    public function index(Request $request)
    {
        $user = $request->user();
        $user->can('live.watch') || abort(403);

        $validated = $request->validate([
            'organization_id' => ['nullable', 'integer'],
            'before_id' => ['nullable', 'integer'],
        ]);

        $organizationId = $this->authorizedOrganizationId($user, $validated['organization_id'] ?? null);

        if ($organizationId === null) {
            return $this->fail('Anda tidak berwenang membuka chat site ini', null, 403);
        }

        $messages = ChatMessage::query()
            ->with(['user:id,name', 'replyTo.user:id,name'])
            ->where('organization_id', $organizationId)
            ->when($validated['before_id'] ?? null, fn ($query, $beforeId) => $query->where('id', '<', $beforeId))
            ->latest('id')
            ->limit(self::PAGE_SIZE)
            ->get()
            ->reverse()
            ->values();

        return $this->success('Riwayat chat', [
            'organization_id' => $organizationId,
            'messages' => $messages->map(fn (ChatMessage $message) => $message->toPayload()),
            'has_more' => $messages->count() === self::PAGE_SIZE,
        ]);
    }

    /** Satu pesan -- dipakai gateway untuk menyiarkan pesan bergambar yang baru diunggah. */
    public function show(Request $request, ChatMessage $chatMessage)
    {
        $user = $request->user();
        $user->can('live.watch') || abort(403);

        if ($this->authorizedOrganizationId($user, $chatMessage->organization_id) !== $chatMessage->organization_id) {
            return $this->fail('Anda tidak berwenang membuka chat site ini', null, 403);
        }

        return $this->success('Pesan', $chatMessage->load(['user:id,name', 'replyTo.user:id,name'])->toPayload());
    }

    public function store(Request $request)
    {
        $user = $request->user();
        $user->can('live.watch') || abort(403);

        $validated = $request->validate([
            'organization_id' => ['nullable', 'integer'],
            'body' => ['nullable', 'string', 'max:1000'],
            'reply_to_id' => ['nullable', 'integer'],
            // Daftar tertutup (tanpa SVG -- bisa berisi skrip) & dicek dari isi berkas.
            'image' => ['nullable', 'file', 'mimes:jpg,jpeg,png,webp,gif', 'mimetypes:image/jpeg,image/png,image/webp,image/gif', 'max:'.self::MAX_IMAGE_KB, 'dimensions:max_width=10000,max_height=10000'],
        ]);

        $body = trim($validated['body'] ?? '');
        $image = $request->file('image');

        if ($body === '' && ! $image) {
            return $this->fail('Pesan tidak boleh kosong', null, 422);
        }

        $organizationId = $this->authorizedOrganizationId($user, $validated['organization_id'] ?? null);

        if ($organizationId === null) {
            return $this->fail('Anda tidak berwenang mengirim pesan ke site ini', null, 403);
        }

        // Yang dibalas harus pesan di ruang chat yang sama.
        $replyToId = $validated['reply_to_id'] ?? null;
        if ($replyToId !== null && ! ChatMessage::where('id', $replyToId)->where('organization_id', $organizationId)->exists()) {
            return $this->fail('Pesan yang dibalas tidak ditemukan', null, 422);
        }

        $imageAttributes = [];
        if ($image) {
            [$width, $height] = @getimagesize($image->getRealPath()) ?: [null, null];
            try {
                $path = $this->chatImagesDisk()->putFileAs(
                    "chat/{$organizationId}",
                    $image,
                    Str::uuid().'.'.$image->extension(),
                );
            } catch (Throwable $exception) {
                report($exception);
                $path = false;
            }

            if ($path === false) {
                return $this->fail('Gambar gagal disimpan ke penyimpanan server, coba lagi sebentar lagi', null, 503);
            }

            $imageAttributes = [
                'image_path' => $path,
                'image_mime' => $image->getMimeType(),
                'image_width' => $width,
                'image_height' => $height,
            ];
        }

        $message = ChatMessage::create([
            'organization_id' => $organizationId,
            'user_id' => $user->id,
            'reply_to_id' => $replyToId,
            'body' => $body === '' ? null : $body,
            ...$imageAttributes,
        ])->setRelation('user', $user)->load('replyTo.user:id,name');

        return $this->success('Pesan terkirim', $message->toPayload(), 201);
    }

    /**
     * Gambar chat lewat tautan bertanda tangan (route tanpa auth:sanctum,
     * supaya bisa dipakai langsung di <img>); tautannya dibuat hanya untuk
     * user yang boleh membaca ruang chat itu.
     */
    public function image(Request $request, ChatMessage $chatMessage)
    {
        if (! $request->hasValidSignature()) {
            return $this->fail('Tautan kedaluwarsa atau tidak valid', null, 403);
        }

        if (! $chatMessage->image_path || ! $this->chatImagesDisk()->exists($chatMessage->image_path)) {
            return $this->fail('Gambar tidak ditemukan', null, 404);
        }

        return $this->serveImageFromDisk(
            config('filesystems.chat_images_disk'),
            $chatMessage->image_path,
            $chatMessage->image_mime ?? 'application/octet-stream',
        );
    }

    private function chatImagesDisk(): Filesystem
    {
        return Storage::disk(config('filesystems.chat_images_disk'));
    }
}
