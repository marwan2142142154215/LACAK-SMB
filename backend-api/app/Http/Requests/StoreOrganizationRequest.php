<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class StoreOrganizationRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('organizations.manage');
    }

    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'type' => ['required', Rule::in(['company_asset'])],
        ];
    }

    /**
     * Kode unik site dibuat server-side, tidak diisi manual, agar tidak bisa
     * ditebak/diduplikasi (dipakai untuk menandai APK pelacak per site).
     * SENGAJA diawali slug nama site (mis. "devtest" -> DEVTEST-XXXXXXXX)
     * supaya kode tetap bisa dikenali manusia sesuai nama site-nya, bukan
     * acak total -- site dengan ratusan device perlu bisa membedakan APK
     * mana untuk site mana sekilas lihat, bagian acak di belakang tetap
     * menjaga keunikan antar site walau dua site punya nama mirip/sama.
     */
    public function generatedSiteCode(): string
    {
        $slug = strtoupper(Str::slug($this->input('name', ''), ''));
        // unique_site_code kolomnya varchar(32) -- sisakan ruang untuk "-" + 8 karakter acak.
        $prefix = $slug !== '' ? Str::limit($slug, 22, '') : 'SITE';

        return $prefix.'-'.strtoupper(Str::random(8));
    }
}
