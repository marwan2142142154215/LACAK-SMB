<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Responses\ApiResponse;
use App\Models\ChatMessage;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Http\Request;

/**
 * Chat staf per site. Satu ruang chat = satu site; siapa yang boleh membaca
 * & menulis memakai aturan yang sama dengan Live Kerja (live.watch +
 * ResolvesOrganizationScope): staf hanya site-nya sendiri, admin/leader
 * site yang diberikan, super_admin semua site.
 *
 * Realtime-gateway memanggil kedua endpoint ini dengan token user yang
 * sedang chat (bukan token sistem), jadi gateway tidak pernah memutuskan
 * sendiri siapa boleh masuk ruang chat mana.
 */
class ChatMessageController extends Controller
{
    use ApiResponse, ResolvesOrganizationScope;

    private const PAGE_SIZE = 50;

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
            ->with('user:id,name')
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

    public function store(Request $request)
    {
        $user = $request->user();
        $user->can('live.watch') || abort(403);

        $validated = $request->validate([
            'organization_id' => ['nullable', 'integer'],
            'body' => ['required', 'string', 'max:1000'],
        ]);

        $body = trim($validated['body']);

        if ($body === '') {
            return $this->fail('Pesan tidak boleh kosong', null, 422);
        }

        $organizationId = $this->authorizedOrganizationId($user, $validated['organization_id'] ?? null);

        if ($organizationId === null) {
            return $this->fail('Anda tidak berwenang mengirim pesan ke site ini', null, 403);
        }

        $message = ChatMessage::create([
            'organization_id' => $organizationId,
            'user_id' => $user->id,
            'body' => $body,
        ])->setRelation('user', $user);

        return $this->success('Pesan terkirim', $message->toPayload(), 201);
    }
}
