import { extname } from 'node:path'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { accessOf, can } from '#services/access'
import { fail, success } from '#services/api_response'
import { laravelDate, logModelEvent } from '#services/activity_log'
import {
    documentsDiskFileExists,
    laravelSlug,
    serveDocumentsDiskFile,
    storeUploadedFile,
} from '#services/documents'
import { laravelUrlSigner } from '#services/laravel/index'
import { authorizedOrganizationId, organizationFilter } from '#services/organization_scope'
import { documentsDiskName } from '#services/storage'
import {
    paginationOf,
    parseLaravelDate,
    requestedOrganizationId,
    storeConsentDocumentValidator,
} from '#validators/rules'

/** subject_type activity_log untuk model ConsentDocument Laravel. */
export const CONSENT_DOCUMENT_MORPH = 'App\\Models\\ConsentDocument'

/** Umur document_url, sama dengan ConsentDocumentResource (15 menit). */
const DOCUMENT_URL_MINUTES = 15

export type ConsentDocumentRow = {
    id: number
    organization_id: number
    subject_name: string
    signer_name: string
    signer_role: string
    document_file_path: string
    signed_at: Date | string
    valid_until: Date | string | null
    revoked_at: Date | null
    created_at: Date | null
}

/**
 * Kolom `date` (cast 'date' Eloquent) diserialisasi sebagai tengah malam UTC:
 * 2026-10-01T00:00:00.000000Z. node-postgres membaca kolom date sebagai
 * tengah malam waktu LOKAL, jadi komponen tanggalnya dibaca secara lokal.
 */
export function laravelDateOnly(value: Date | string | null): string | null {
    if (value === null) return null
    if (typeof value === 'string') return `${value.slice(0, 10)}T00:00:00.000000Z`
    const pad = (number: number) => String(number).padStart(2, '0')
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T00:00:00.000000Z`
}

/**
 * ConsentDocument::isActive(): belum dicabut dan valid_until (tengah malam
 * tanggal itu) belum lewat.
 */
export function isConsentActive(document: ConsentDocumentRow, now: Date = new Date()): boolean {
    if (document.revoked_at !== null) return false
    const validUntil = laravelDateOnly(document.valid_until)
    if (validUntil !== null && new Date(validUntil.replace('.000000Z', 'Z')) < now) return false
    return true
}

/** Nama berkas unduhan: Str::slug(subject_name)-consent.<ekstensi berkas>. */
export function consentDownloadName(
    document: Pick<ConsentDocumentRow, 'subject_name' | 'document_file_path'>
) {
    return `${laravelSlug(document.subject_name)}-consent.${extname(document.document_file_path).slice(1)}`
}

/** ConsentDocumentResource. */
export function consentDocumentResource(document: ConsentDocumentRow, now: Date = new Date()) {
    return {
        id: document.id,
        organization_id: document.organization_id,
        subject_name: document.subject_name,
        signer_name: document.signer_name,
        signer_role: document.signer_role,
        // Tautan bertanda waktu (standar 6.3) lewat route API sendiri, bukan URL
        // disk langsung -- supaya tetap konsisten baik disk 'local' maupun 'spaces'.
        document_url: laravelUrlSigner.temporarySignedUrl(
            `/api/v1/consent-documents/${document.id}/download`,
            new Date(now.getTime() + DOCUMENT_URL_MINUTES * 60_000)
        ),
        signed_at: laravelDateOnly(document.signed_at),
        valid_until: laravelDateOnly(document.valid_until),
        revoked_at: laravelDate(document.revoked_at),
        is_active: isConsentActive(document, now),
        created_at: laravelDate(document.created_at),
    }
}

/** Nilai logOnly ConsentDocument (subject_name, signer_name, signer_role, revoked_at). */
function loggedAttributesOf(document: ConsentDocumentRow) {
    return {
        subject_name: document.subject_name,
        signer_name: document.signer_name,
        signer_role: document.signer_role,
        revoked_at: laravelDate(document.revoked_at),
    }
}

/**
 * Nilai kolom `date` seperti cast 'date' Eloquent saat disimpan: Carbon
 * membaca isian (dengan offset-nya sendiri kalau ada) lalu bagian tanggalnya
 * yang tersimpan -- jadi "2026-10-01T23:00:00+07:00" tetap 2026-10-01.
 */
export function dateColumnValue(value: string): string {
    const trimmed = value.trim()
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
        return trimmed.slice(0, 10)
    }
    return parseLaravelDate(trimmed)!.toISOString().slice(0, 10)
}

/**
 * Dokumen consent bertanda tangan per site -- padanan ConsentDocumentController
 * di backend-api, kontrak sama. Pencabutan (bukan hapus) membuat device yang
 * terkait tidak lagi boleh menerima perintah.
 */
export default class ConsentDocumentsController {
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'consent-documents.manage')) return forbidden(ctx)

        const filter = organizationFilter(access, requestedOrganizationId(ctx))
        if (filter === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melihat dokumen consent site ini'))
        }

        const { page, perPage } = paginationOf(ctx, 15)
        const query = db.from('consent_documents').orderBy('signed_at', 'desc')
        if (filter !== 'all') {
            query.whereIn('organization_id', filter)
        }
        const documents = await query.paginate(page, perPage)

        const now = new Date()
        return success('Daftar dokumen consent', {
            items: documents
                .all()
                .map((document) => consentDocumentResource(document as ConsentDocumentRow, now)),
            total: documents.total,
        })
    }

    async store(ctx: HttpContext) {
        // StoreConsentDocumentRequest::authorize() jalan sebelum validasi.
        const access = await accessOf(ctx)
        if (!can(access, 'consent-documents.manage')) return forbidden(ctx)

        const input = await ctx.request.validateUsing(storeConsentDocumentValidator)

        const organizationId = authorizedOrganizationId(access, input.organization_id)
        if (organizationId === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang membuat consent untuk site ini'))
        }

        const path = await storeUploadedFile(
            input.document_file,
            `consent-documents/${organizationId}`,
            documentsDiskName()
        )

        const now = new Date()
        const [document] = await db
            .table('consent_documents')
            .insert({
                organization_id: organizationId,
                subject_name: input.subject_name,
                signer_name: input.signer_name,
                signer_role: input.signer_role,
                document_file_path: path,
                signed_at: dateColumnValue(input.signed_at),
                valid_until: input.valid_until ? dateColumnValue(input.valid_until) : null,
                created_by: access.userId,
                updated_by: access.userId,
                created_at: now,
                updated_at: now,
            })
            .returning('*')

        await logModelEvent(ctx, {
            event: 'created',
            subjectType: CONSENT_DOCUMENT_MORPH,
            subjectId: document.id,
            organizationId: document.organization_id,
            attributes: loggedAttributesOf(document),
        })

        return ctx.response
            .status(201)
            .send(success('Dokumen consent berhasil disimpan', consentDocumentResource(document)))
    }

    async show(ctx: HttpContext) {
        const document = await findDocument(ctx.params.consent_document)
        if (!document) return notFound(ctx)

        const access = await accessOf(ctx)
        if (!can(access, 'consent-documents.manage')) return forbidden(ctx)

        if (authorizedOrganizationId(access, document.organization_id) === null) {
            return ctx.response.status(403).send(fail('Anda tidak berwenang melihat dokumen ini'))
        }

        return success('Detail consent', consentDocumentResource(document))
    }

    /**
     * Pencabutan consent (bukan hard delete) -- begitu dicabut, semua device
     * yang terkait otomatis tidak boleh lagi menerima perintah (ditegakkan
     * di perintah device).
     */
    async revoke(ctx: HttpContext) {
        const document = await findDocument(ctx.params.consentDocument)
        if (!document) return notFound(ctx)

        const access = await accessOf(ctx)
        if (!can(access, 'consent-documents.manage')) return forbidden(ctx)

        if (authorizedOrganizationId(access, document.organization_id) === null) {
            return ctx.response.status(403).send(fail('Anda tidak berwenang mencabut dokumen ini'))
        }

        // Kolom timestamp(0): detik dibulatkan ke bawah seperti format Y-m-d H:i:s.
        const revokedAt = new Date(Math.floor(Date.now() / 1000) * 1000)
        const [updated] = await db
            .from('consent_documents')
            .where('id', document.id)
            .update({ revoked_at: revokedAt, updated_by: access.userId, updated_at: new Date() })
            .returning('*')

        const before = loggedAttributesOf(document)
        const after = loggedAttributesOf(updated)
        if (before.revoked_at !== after.revoked_at) {
            await logModelEvent(ctx, {
                event: 'updated',
                subjectType: CONSENT_DOCUMENT_MORPH,
                subjectId: document.id,
                organizationId: document.organization_id,
                attributes: { revoked_at: after.revoked_at },
                old: { revoked_at: before.revoked_at },
            })
        }

        return success(
            'Consent dicabut. Device terkait tidak lagi bisa menerima perintah.',
            consentDocumentResource(updated)
        )
    }

    /**
     * Download lewat signed URL sementara (standar 6.3), bukan akses publik
     * langsung. Route ini sendiri bertanda tangan; berkasnya lalu dibuka lewat
     * tautan bertanda waktu Spaces (lihat services/documents.ts).
     */
    async download(ctx: HttpContext) {
        // Urutan backend-api: route model binding (404) dulu, lalu middleware
        // 'signed' (403 dengan pesan 403 umum dari bootstrap/app.php).
        const document = await findDocument(ctx.params.consentDocument)
        if (!document) return notFound(ctx)

        if (!laravelUrlSigner.hasValidSignature(ctx.request.url(), ctx.request.qs())) {
            return forbidden(ctx)
        }

        if (!(await documentsDiskFileExists(document.document_file_path))) {
            return ctx.response.status(404).send(fail('Berkas tidak ditemukan'))
        }

        return serveDocumentsDiskFile(
            ctx,
            document.document_file_path,
            consentDownloadName(document)
        )
    }
}

async function findDocument(id: unknown): Promise<ConsentDocumentRow | null> {
    return (await db.from('consent_documents').where('id', String(id)).first()) ?? null
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang melakukan tindakan ini'))
}

function notFound(ctx: HttpContext) {
    return ctx.response.status(404).send(fail('Data tidak ditemukan'))
}
