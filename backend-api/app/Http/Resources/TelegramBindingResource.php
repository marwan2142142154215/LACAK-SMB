<?php

namespace App\Http\Resources;

use App\Models\TelegramBinding;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin TelegramBinding */
class TelegramBindingResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'organization_id' => $this->organization_id,
            'telegram_chat_id' => $this->telegram_chat_id,
            // bot_token_ref sengaja tidak diekspos penuh walau cuma referensi (standar 6.1).
            'bot_token_ref_masked' => $this->maskedTokenRef(),
            'is_active' => $this->is_active,
            'created_at' => $this->created_at,
        ];
    }

    private function maskedTokenRef(): string
    {
        $ref = $this->bot_token_ref;

        if (strlen($ref) <= 6) {
            return str_repeat('*', strlen($ref));
        }

        return substr($ref, 0, 3).str_repeat('*', strlen($ref) - 6).substr($ref, -3);
    }
}
