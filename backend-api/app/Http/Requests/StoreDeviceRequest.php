<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreDeviceRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('devices.manage');
    }

    public function rules(): array
    {
        return [
            'organization_id' => ['required', 'integer', 'exists:organizations,id'],
            'consent_document_id' => ['required', 'integer', 'exists:consent_documents,id'],
            'device_name' => ['required', 'string', 'max:255'],
            'device_uuid' => ['required', 'string', 'max:255', 'unique:devices,device_uuid'],
            'android_version' => ['required', 'string', 'max:10'],
            'app_build_version' => ['required', 'string', 'max:20'],
            'site_code_embedded' => ['required', 'string', 'max:32'],
        ];
    }
}
