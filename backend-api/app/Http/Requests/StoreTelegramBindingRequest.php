<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreTelegramBindingRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('telegram.manage');
    }

    public function rules(): array
    {
        return [
            'organization_id' => ['required', 'integer', 'exists:organizations,id'],
            'telegram_chat_id' => ['required', 'string', 'max:255'],
            // Referensi ke secret manager/.env (standar 6.1) — bukan token asli.
            'bot_token_ref' => ['required', 'string', 'max:255'],
        ];
    }
}
