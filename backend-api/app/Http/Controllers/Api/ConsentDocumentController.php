<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreConsentDocumentRequest;
use App\Http\Resources\ConsentDocumentResource;
use App\Http\Responses\ApiResponse;
use App\Models\ConsentDocument;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

class ConsentDocumentController extends Controller
{
    use ApiResponse, ResolvesOrganizationScope;

    public function index(Request $request)
    {
        $request->user()->can('consent-documents.manage') || abort(403);

        $query = $this->scopeToOrganization(
            ConsentDocument::query(),
            $request->user(),
            $request->integer('organization_id') ?: null
        );

        if ($query === null) {
            return $this->fail('Anda tidak berwenang melihat dokumen consent site ini', null, 403);
        }

        $documents = $query->orderByDesc('signed_at')->paginate($request->integer('per_page', 15));

        return $this->success('Daftar dokumen consent', [
            'items' => ConsentDocumentResource::collection($documents),
            'total' => $documents->total(),
        ]);
    }

    public function store(StoreConsentDocumentRequest $request)
    {
        $organizationId = $this->authorizedOrganizationId($request->user(), (int) $request->validated('organization_id'));

        if ($organizationId === null) {
            return $this->fail('Anda tidak berwenang membuat consent untuk site ini', null, 403);
        }

        $disk = config('filesystems.documents_disk');
        $path = $request->file('document_file')->store("consent-documents/{$organizationId}", $disk);

        $document = ConsentDocument::create([
            'organization_id' => $organizationId,
            'subject_name' => $request->validated('subject_name'),
            'signer_name' => $request->validated('signer_name'),
            'signer_role' => $request->validated('signer_role'),
            'document_file_path' => $path,
            'signed_at' => $request->validated('signed_at'),
            'valid_until' => $request->validated('valid_until'),
            'created_by' => $request->user()->id,
        ]);

        return $this->success('Dokumen consent berhasil disimpan', new ConsentDocumentResource($document), 201);
    }

    public function show(Request $request, ConsentDocument $consentDocument)
    {
        $request->user()->can('consent-documents.manage') || abort(403);

        if ($this->authorizedOrganizationId($request->user(), $consentDocument->organization_id) === null) {
            return $this->fail('Anda tidak berwenang melihat dokumen ini', null, 403);
        }

        return $this->success('Detail consent', new ConsentDocumentResource($consentDocument));
    }

    /**
     * Pencabutan consent (bukan hard delete) — begitu dicabut, semua device
     * yang terkait otomatis tidak boleh lagi menerima perintah (ditegakkan
     * di DeviceCommandController::store).
     */
    public function revoke(Request $request, ConsentDocument $consentDocument)
    {
        $request->user()->can('consent-documents.manage') || abort(403);

        if ($this->authorizedOrganizationId($request->user(), $consentDocument->organization_id) === null) {
            return $this->fail('Anda tidak berwenang mencabut dokumen ini', null, 403);
        }

        $consentDocument->update(['revoked_at' => now()]);

        return $this->success('Consent dicabut. Device terkait tidak lagi bisa menerima perintah.', new ConsentDocumentResource($consentDocument));
    }

    /**
     * Download lewat signed URL sementara (standar 6.3), bukan akses publik langsung.
     */
    public function download(Request $request, ConsentDocument $consentDocument)
    {
        if (! $request->hasValidSignature()) {
            return $this->fail('Tautan kedaluwarsa atau tidak valid', null, 403);
        }

        $disk = config('filesystems.documents_disk');

        if (! Storage::disk($disk)->exists($consentDocument->document_file_path)) {
            return $this->fail('Berkas tidak ditemukan', null, 404);
        }

        $filename = Str::slug($consentDocument->subject_name).'-consent.'.pathinfo($consentDocument->document_file_path, PATHINFO_EXTENSION);

        return Storage::disk($disk)->download($consentDocument->document_file_path, $filename);
    }
}
