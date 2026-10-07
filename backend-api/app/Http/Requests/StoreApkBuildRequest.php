<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreApkBuildRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('apk-builds.manage');
    }

    public function rules(): array
    {
        return [
            'organization_id' => ['required', 'integer', 'exists:organizations,id'],
            'version' => ['required', 'string', 'max:20'],
            // File APK hasil build (ditandatangani kode site saat proses build Android,
            // lihat android-tracked-app). Server hanya menyimpan & mencatat checksum-nya.
            // 'apk' bukan ekstensi yang dikenal Symfony Mime, jadi rule `mimes:apk`
            // bawaan Laravel selalu gagal — validasi ekstensi & MIME manual di bawah.
            'apk_file' => [
                'required',
                'file',
                'max:204800',
                function ($attribute, $value, $fail) {
                    if (strtolower($value->getClientOriginalExtension()) !== 'apk') {
                        $fail('Berkas harus berekstensi .apk');

                        return;
                    }

                    $allowedMimes = [
                        'application/vnd.android.package-archive',
                        'application/zip',
                        'application/octet-stream',
                    ];

                    if (! in_array($value->getMimeType(), $allowedMimes, true)) {
                        $fail('Berkas APK tidak valid');
                    }
                },
            ],
        ];
    }
}
