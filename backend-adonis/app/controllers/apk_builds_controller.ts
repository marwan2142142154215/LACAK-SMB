import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { extname } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { accessOf, can } from '#services/access'
import { fail, success } from '#services/api_response'
import { laravelDate, logModelEvent } from '#services/activity_log'
import { laravelUrlSigner } from '#services/laravel/index'
import { authorizedOrganizationId, organizationFilter } from '#services/organization_scope'
import { serveDocumentsDiskFile } from '#services/documents'
import { disk, documentsDiskName } from '#services/storage'
import { sha256File } from '#services/apk_builder'
import {
    validateGenerateApkBuild,
    validateStoreApkBuild,
    type UploadedApk,
} from '#validators/apk_builds'
// Belum ada alias #jobs/* di package.json (lihat laporan modul apk).
import { dispatchBuildApk } from '#jobs/build_apk_job'

export const DEVICE_MORPH = 'App\\Models\\Device'

/** DeviceEnrollmentController::SECRET_BYTES di backend-api. */
const DEVICE_SECRET_BYTES = 32

/** Tautan unduh di ApkBuildResource berlaku 30 menit. */
const DOWNLOAD_URL_MINUTES = 30

/** Paginator Laravel: per_page 0 -> perPage bawaan model (15). */
const DEFAULT_MODEL_PER_PAGE = 15

type ApkBuildRow = {
    id: number
    organization_id: number
    organization_name?: string | null
    apk_type: string | null
    version: string
    status: string | null
    file_path: string | null
    embedded_site_code: string | null
    checksum_sha256: string | null
    build_log: string | null
    created_at: Date | null
}

/**
 * Registry APK pelacak per site -- padanan ApkBuildController di backend-api.
 * embedded_site_code + checksum dipakai APK saat start untuk menolak jalan
 * kalau ada duplikasi kode site dengan checksum berbeda (APK bajakan).
 */
export default class ApkBuildsController {
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'apk-builds.manage')) return forbidden(ctx)

        const filter = organizationFilter(
            access,
            phpIntval(ctx.request.input('organization_id')) || null
        )
        if (filter === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melihat APK build site ini'))
        }

        const query = buildsQuery()
        if (filter !== 'all') {
            query.whereIn('apk_builds.organization_id', filter)
        }

        // $request->integer('per_page', 20) lalu paginate(): 0 -> bawaan model.
        const perPageInput = ctx.request.input('per_page', 20)
        const perPage =
            phpIntval(perPageInput) > 0 ? phpIntval(perPageInput) : DEFAULT_MODEL_PER_PAGE
        const page = currentPage(ctx.request.input('page'))

        const totalRow = await query.clone().clearSelect().count('* as total').first()
        const rows: ApkBuildRow[] = await query
            .orderBy('apk_builds.id', 'desc')
            .limit(perPage)
            .offset((page - 1) * perPage)

        return success('Daftar APK build', {
            items: rows.map((row) => apkBuildResource(row)),
            total: Number(totalRow?.total ?? 0),
        })
    }

    async show(ctx: HttpContext) {
        // Route model binding Laravel jalan sebelum controller: 404 dulu, baru 403.
        const build = await findBuild(ctx.params.apk_build)
        if (!build) return notFound(ctx)

        const access = await accessOf(ctx)
        if (!can(access, 'apk-builds.manage')) return forbidden(ctx)

        if (authorizedOrganizationId(access, build.organization_id) === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melihat APK build site ini'))
        }

        return success('Detail APK build', apkBuildResource(build))
    }

    async store(ctx: HttpContext) {
        // FormRequest::authorize() dicek sebelum validasi.
        const access = await accessOf(ctx)
        if (!can(access, 'apk-builds.manage')) return forbidden(ctx)

        const file = ctx.request.file('apk_file')
        const uploaded: UploadedApk | null = file
            ? {
                  clientExtension: extname(file.clientName).replace(/^\./, ''),
                  mimeType: file.type && file.subtype ? `${file.type}/${file.subtype}` : null,
                  sizeBytes: file.size,
                  isValid: file.isValid && !!file.tmpPath,
              }
            : null

        const result = await validateStoreApkBuild(ctx.request.all(), uploaded)
        if ('errors' in result) return validationFailed(ctx, result.errors)

        const organizationId = authorizedOrganizationId(access, result.data.organization_id)
        if (organizationId === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang mengunggah APK untuk site ini'))
        }

        const organization = await findOrganization(organizationId)
        if (!organization) return notFound(ctx)

        const tmpPath = file!.tmpPath!
        const mimeType = uploaded!.mimeType ?? 'application/octet-stream'
        const checksum = await sha256File(tmpPath)
        // $file->store(): nama acak 40 karakter + ekstensi tebakan dari MIME.
        const path = `apk-builds/${organizationId}/${laravelRandomString(40)}.${guessExtension(mimeType)}`
        await disk(documentsDiskName()).put(path, await readFile(tmpPath), mimeType)

        const now = new Date()
        const [inserted] = await db
            .table('apk_builds')
            .insert({
                organization_id: organizationId,
                version: result.data.version,
                file_path: path,
                embedded_site_code: organization.unique_site_code,
                checksum_sha256: checksum,
                built_by: access.userId,
                created_at: now,
                updated_at: now,
            })
            .returning(['id'])

        // Model hasil create() di Laravel tidak memuat ulang nilai bawaan
        // kolom (apk_type 'tracker', status 'success'), jadi resource-nya
        // mengirim null untuk keduanya -- dipertahankan supaya kontrak sama.
        return ctx.response.status(201).send(
            success(
                'APK berhasil diunggah dan didaftarkan',
                apkBuildResource({
                    id: inserted.id,
                    organization_id: organizationId,
                    organization_name: organization.name,
                    apk_type: null,
                    version: result.data.version,
                    status: null,
                    file_path: path,
                    embedded_site_code: organization.unique_site_code,
                    checksum_sha256: checksum,
                    build_log: null,
                    created_at: now,
                })
            )
        )
    }

    /**
     * Memicu build APK sungguhan (tracker, master, live, atau server) untuk
     * satu site lewat antrean (build_apk_job -> apk_builder, Gradle via
     * WSL2). Mengembalikan baris 'pending' segera; klien polling
     * GET /apk-builds sampai status berubah success/failed.
     */
    async generate(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'apk-builds.manage')) return forbidden(ctx)

        const result = await validateGenerateApkBuild(ctx.request.all())
        if ('errors' in result) return validationFailed(ctx, result.errors)
        const input = result.data

        const organizationId = authorizedOrganizationId(access, input.organization_id)
        if (organizationId === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang membuat APK untuk site ini'))
        }

        const organization = await findOrganization(organizationId)
        if (!organization) return notFound(ctx)

        // SMB Live Kerja satu untuk semua site: selama sudah ada yang berhasil
        // (atau sedang dibuild), staf cukup mengunduh yang itu. Build ulang
        // (versi baru) = hapus arsip lama dulu.
        if (input.apk_type === 'live') {
            const existing = await db
                .from('apk_builds')
                .where('apk_type', 'live')
                .whereIn('status', ['pending', 'success'])
                .orderBy('id', 'desc')
                .select('version', 'status')
                .first()
            if (existing) {
                return ctx.response
                    .status(422)
                    .send(
                        fail(
                            existing.status === 'pending'
                                ? `SMB Live Kerja v${existing.version} sedang dibuild, tunggu sampai selesai`
                                : `SMB Live Kerja v${existing.version} sudah ada, cukup unduh yang itu. Hapus arsipnya dulu bila ingin build versi baru.`
                        )
                    )
            }
        }

        // Zero-touch provisioning: untuk APK tracker, baris device dibuat di
        // sini -- sebelum build Gradle dipicu -- dengan device_uuid & rahasia
        // device digenerate server, lalu keduanya ditanam ke APK. Begitu
        // dipasang, APK langsung bisa terhubung ke gateway tanpa klaim enrollment.
        const version = input.version || '1.0.0'
        const now = new Date()
        const isTracker = input.apk_type === 'tracker'
        const plainDeviceSecret = isTracker
            ? randomBytes(DEVICE_SECRET_BYTES).toString('hex')
            : null

        const created = await db.transaction(async (trx) => {
            let device: { id: number; device_name: string } | null = null

            if (isTracker) {
                // Format sama dengan DeviceEnrollmentController::claim. Yang
                // disimpan hanya hash-nya; token asli cuma ikut payload job
                // build (terenkripsi) untuk ditanam ke APK.
                const [row] = await trx
                    .table('devices')
                    .insert({
                        organization_id: organizationId,
                        device_name: input.device_name,
                        device_uuid: randomUUID(),
                        secret_hash: createHash('sha256').update(plainDeviceSecret!).digest('hex'),
                        // Belum diketahui sampai device fisiknya pertama kali
                        // terhubung; kosong, bukan placeholder seperti "unknown".
                        android_version: '',
                        app_build_version: version,
                        site_code_embedded: organization.unique_site_code,
                        status: 'pending_enrollment',
                        enrolled_at: now,
                        is_active: true,
                        created_by: access.userId,
                        updated_by: access.userId,
                        created_at: now,
                        updated_at: now,
                    })
                    .returning(['id', 'device_name'])
                device = row
            }

            const [build] = await trx
                .table('apk_builds')
                .insert({
                    organization_id: organizationId,
                    device_id: device?.id ?? null,
                    apk_type: input.apk_type,
                    version,
                    status: 'pending',
                    embedded_site_code: organization.unique_site_code,
                    built_by: access.userId,
                    created_at: now,
                    updated_at: now,
                })
                .returning(['id'])

            return { device, buildId: build.id as number }
        })

        // Laravel memasukkan job ke tabel jobs di transaksi yang sama. Redis
        // tidak ikut transaksi Postgres, jadi job dikirim SESUDAH commit
        // (worker tidak pernah melihat baris yang belum ada); kalau gagal
        // dikirim, baris yang baru dibuat dihapus lagi -- hasil akhirnya sama
        // dengan transaksi Laravel yang batal.
        try {
            await dispatchBuildApk(created.buildId, plainDeviceSecret)
        } catch (error) {
            await db.transaction(async (trx) => {
                await trx.from('apk_builds').where('id', created.buildId).delete()
                if (created.device) {
                    await trx.from('devices').where('id', created.device.id).delete()
                }
            })
            throw error
        }

        if (created.device) {
            // Device memakai LogsActivity: logOnly device_name, status, is_active.
            await logModelEvent(ctx, {
                event: 'created',
                subjectType: DEVICE_MORPH,
                subjectId: created.device.id,
                organizationId,
                attributes: {
                    device_name: created.device.device_name,
                    status: 'pending_enrollment',
                    is_active: true,
                },
            })
        }

        return ctx.response.status(202).send(
            success(
                'Build APK dimulai, biasanya selesai dalam 1-2 menit — cek status lewat daftar APK build',
                apkBuildResource({
                    id: created.buildId,
                    organization_id: organizationId,
                    organization_name: organization.name,
                    apk_type: input.apk_type,
                    version,
                    status: 'pending',
                    file_path: null,
                    embedded_site_code: organization.unique_site_code,
                    checksum_sha256: null,
                    build_log: null,
                    created_at: now,
                })
            )
        )
    }

    /**
     * Hapus APK build terdaftar. File di storage ikut dihapus; device yang
     * sudah ter-install tidak terdampak karena di APK sudah tertanam
     * site_code & gateway URL yang dipakai runtime.
     */
    async destroy(ctx: HttpContext) {
        const build = await findBuild(ctx.params.apk_build)
        if (!build) return notFound(ctx)

        const access = await accessOf(ctx)
        if (!can(access, 'apk-builds.manage')) return forbidden(ctx)

        if (authorizedOrganizationId(access, build.organization_id) === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang menghapus APK build site ini'))
        }

        const documentsDisk = disk(documentsDiskName())
        if (build.file_path && (await documentsDisk.exists(build.file_path))) {
            await documentsDisk.delete(build.file_path)
        }

        await db.from('apk_builds').where('id', build.id).delete()

        return success('APK build dihapus dan tempat penyimpanannya dibersihkan', null)
    }

    /** Tautan bertanda tangan dari ApkBuildResource.download_url (tanpa login). */
    async download(ctx: HttpContext) {
        const build = await findBuild(ctx.params.apkBuild)
        if (!build) return notFound(ctx)

        // Middleware `signed` Laravel menolak dengan 403 bawaan (pesan
        // generik), sebelum pesan milik controller sempat dipakai.
        if (!laravelUrlSigner.hasValidSignature(ctx.request.url(), ctx.request.qs())) {
            return forbidden(ctx)
        }

        const diskName = documentsDiskName()
        const documentsDisk = disk(diskName)
        if (!build.file_path || !(await documentsDisk.exists(build.file_path))) {
            return ctx.response.status(404).send(fail('Berkas APK tidak ditemukan'))
        }

        // Spaces: alihkan ke tautan bertanda waktu milik Spaces supaya bucket
        // tetap privat dan berkas besar tidak dialirkan lewat proses Node.
        return serveDocumentsDiskFile(ctx, build.file_path, downloadFilename(build))
    }
}

function buildsQuery() {
    // with('organization'): relasi belongsTo mengabaikan site yang di-soft-delete.
    return db
        .from('apk_builds')
        .leftJoin('organizations', (join) => {
            join.on('organizations.id', 'apk_builds.organization_id').andOnNull(
                'organizations.deleted_at'
            )
        })
        .select('apk_builds.*', 'organizations.name as organization_name')
}

async function findBuild(id: unknown): Promise<ApkBuildRow | null> {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) return null
    return (await buildsQuery().where('apk_builds.id', Number(id)).first()) ?? null
}

async function findOrganization(
    id: number
): Promise<{ id: number; name: string; unique_site_code: string } | null> {
    return (
        (await db
            .from('organizations')
            .where('id', id)
            .whereNull('deleted_at')
            .select('id', 'name', 'unique_site_code')
            .first()) ?? null
    )
}

/** Bentuk yang sama dengan ApkBuildResource di backend-api. */
export function apkBuildResource(build: ApkBuildRow, now: Date = new Date()) {
    return {
        id: build.id,
        organization_id: build.organization_id,
        organization_name: build.organization_name ?? null,
        apk_type: build.apk_type,
        version: build.version,
        status: build.status,
        embedded_site_code: build.embedded_site_code,
        checksum_sha256: build.checksum_sha256,
        build_log: build.build_log,
        download_url:
            build.status === 'success'
                ? laravelUrlSigner.temporarySignedUrl(
                      `/api/v1/apk-builds/${build.id}/download`,
                      new Date(now.getTime() + DOWNLOAD_URL_MINUTES * 60_000)
                  )
                : null,
        created_at: laravelDate(build.created_at),
    }
}

/**
 * Nama berkas unduhan. APK master & live bersifat universal (bukan milik
 * satu site) -- nama file tidak menyebut site, cukup apk-{tipe}-v{versi}.apk.
 */
export function downloadFilename(build: {
    apk_type: string | null
    version: string
    organization_name?: string | null
}): string {
    // Nama file = nama aplikasinya di HP (SMB Admin, SMB Live Kerja, SMB Pelacak).
    if (build.apk_type === 'master') return `smb-admin-v${build.version}.apk`
    if (build.apk_type === 'live') return `smb-live-kerja-v${build.version}.apk`
    const isServer = build.apk_type === 'server'
    const typeLabel = isServer ? 'lacak-server' : 'smb-pelacak'
    const slugName = laravelSlug(build.organization_name ?? 'site')
    return `${typeLabel}-${slugName}-v${build.version}${isServer ? '.exe' : '.apk'}`
}

/** Str::slug() Laravel (pemisah '-'). */
export function laravelSlug(title: string): string {
    return title
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/_+/g, '-')
        .replace(/@/g, '-at-')
        .toLowerCase()
        .replace(/[^-\p{L}\p{N}\s]+/gu, '')
        .replace(/[-\s]+/gu, '-')
        .replace(/^-+|-+$/g, '')
}

/** Str::random(): huruf & angka acak. */
export function laravelRandomString(length: number): string {
    let result = ''
    while (result.length < length) {
        result += randomBytes(length).toString('base64').replace(/[/+=]/g, '')
    }
    return result.slice(0, length)
}

/** UploadedFile::guessExtension() (Symfony MimeTypes) untuk MIME yang diizinkan. */
export function guessExtension(mimeType: string): string {
    const map: Record<string, string> = {
        'application/vnd.android.package-archive': 'apk',
        'application/zip': 'zip',
        'application/octet-stream': 'bin',
    }
    return map[mimeType] ?? 'bin'
}

/** filter_var(FILTER_VALIDATE_INT) + >= 1, seperti Paginator::resolveCurrentPage. */
function currentPage(value: unknown): number {
    const text = String(value ?? '')
    const page = Number(text)
    return /^\s*\+?\d+\s*$/.test(text) && Number.isSafeInteger(page) && page >= 1 ? page : 1
}

/** intval() PHP untuk masukan request. */
export function phpIntval(value: unknown): number {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0
    if (typeof value === 'boolean') return value ? 1 : 0
    if (typeof value !== 'string') return 0
    const match = value.match(/^\s*([+-]?\d+)/)
    return match ? Number.parseInt(match[1], 10) : 0
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang melakukan tindakan ini'))
}

function notFound(ctx: HttpContext) {
    return ctx.response.status(404).send(fail('Data tidak ditemukan'))
}

function validationFailed(ctx: HttpContext, errors: Record<string, string[]>) {
    return ctx.response.status(422).send(fail('Isian tidak lolos validasi', errors))
}
