<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreTelegramBindingRequest;
use App\Http\Resources\TelegramBindingResource;
use App\Http\Responses\ApiResponse;
use App\Models\TelegramBinding;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Http\Request;

class TelegramBindingController extends Controller
{
    use ApiResponse, ResolvesOrganizationScope;

    public function index(Request $request)
    {
        $request->user()->can('telegram.manage') || abort(403);

        $query = $this->scopeToOrganization(TelegramBinding::query(), $request->user(), $request->integer('organization_id') ?: null);

        if ($query === null) {
            return $this->fail('Anda tidak berwenang melihat binding Telegram site ini', null, 403);
        }

        $bindings = $query->latest('id')->get();

        return $this->success('Daftar binding Telegram', TelegramBindingResource::collection($bindings));
    }

    public function store(StoreTelegramBindingRequest $request)
    {
        $organizationId = $this->authorizedOrganizationId($request->user(), (int) $request->validated('organization_id'));

        if ($organizationId === null) {
            return $this->fail('Anda tidak berwenang menautkan Telegram untuk site ini', null, 403);
        }

        $binding = TelegramBinding::create([
            'organization_id' => $organizationId,
            'telegram_chat_id' => $request->validated('telegram_chat_id'),
            'bot_token_ref' => $request->validated('bot_token_ref'),
            'is_active' => true,
        ]);

        return $this->success('Binding Telegram berhasil dibuat', new TelegramBindingResource($binding), 201);
    }

    /**
     * Dipakai bot Telegram (role telegram_bot_service) untuk mencocokkan
     * chat_id yang baru saja mengirim pesan ke organization_id-nya, tanpa
     * perlu permission 'telegram.manage' penuh (bot tidak boleh kelola
     * binding, hanya boleh tahu dia melayani site mana). Hanya organization_id
     * yang dibalas — bot_token_ref dan field lain tidak diekspos di sini.
     */
    public function lookup(Request $request)
    {
        $chatId = $request->string('chat_id')->toString();

        if ($chatId === '') {
            return $this->fail('chat_id wajib diisi', null, 422);
        }

        $binding = TelegramBinding::where('telegram_chat_id', $chatId)->where('is_active', true)->first();

        if (! $binding) {
            return $this->fail('Chat ini belum terdaftar ke site mana pun', null, 404);
        }

        return $this->success('Binding ditemukan', ['organization_id' => $binding->organization_id]);
    }

    public function destroy(Request $request, TelegramBinding $telegramBinding)
    {
        $request->user()->can('telegram.manage') || abort(403);

        if ($this->authorizedOrganizationId($request->user(), $telegramBinding->organization_id) === null) {
            return $this->fail('Anda tidak berwenang menghapus binding ini', null, 403);
        }

        $telegramBinding->delete();

        return $this->success('Binding Telegram berhasil dihapus');
    }
}
