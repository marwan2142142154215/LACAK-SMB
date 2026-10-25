import { randomInt } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { HttpContext } from '@adonisjs/core/http'
import type { MultipartFile } from '@adonisjs/core/bodyparser'
import { disk, documentsDiskName, type DiskName } from '#services/storage'

/**
 * Padanan trait ServesDocumentsDiskFiles di backend-api: berkas penting
 * (dokumen consent, APK, gambar chat) disajikan lewat tautan bertanda waktu
 * milik Spaces sendiri, supaya bucket tetap privat dan berkas besar (APK)
 * tidak perlu dialirkan lewat proses Node. Disk lokal hanya dipakai di
 * lingkungan dev, jadi di sana berkas dialirkan langsung.
 */

/** Umur tautan Spaces, sama dengan TEMPORARY_FILE_URL_MINUTES backend-api. */
export const TEMPORARY_FILE_URL_MINUTES = 5

export function documentsDiskFileExists(path: string | null | undefined): Promise<boolean> {
    if (path === null || path === undefined || path === '') return Promise.resolve(false)
    return disk(documentsDiskName()).exists(path)
}

/** Unduh berkas dari disk dokumen (Content-Disposition: attachment). */
export async function serveDocumentsDiskFile(ctx: HttpContext, path: string, downloadName: string) {
    const diskName = documentsDiskName()

    if (diskName !== 'spaces') {
        return streamFromDisk(ctx, diskName, path, {
            'Content-Type': mimeTypeFor(path),
            'Content-Disposition': attachmentDisposition(downloadName),
        })
    }

    const url = await temporaryUrl(path, {
        responseContentDisposition: `attachment; filename="${addSlashes(downloadName)}"`,
    })
    return ctx.response.redirect(url)
}

/**
 * Gambar untuk ditampilkan langsung (<img>), bukan diunduh. Content-Type
 * dipaksa dari tipe yang tervalidasi saat unggah + nosniff, supaya browser
 * tidak pernah menafsirkan berkas sebagai HTML/skrip.
 */
export async function serveImageFromDisk(
    ctx: HttpContext,
    diskName: DiskName,
    path: string,
    mimeType: string
) {
    if (diskName !== 'spaces') {
        return streamFromDisk(ctx, diskName, path, {
            'Content-Type': mimeType,
            'Content-Disposition': 'inline',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=3600',
        })
    }

    const url = await temporaryUrl(path, {
        responseContentType: mimeType,
        responseContentDisposition: 'inline',
    })
    return ctx.response.redirect(url)
}

async function streamFromDisk(
    ctx: HttpContext,
    diskName: DiskName,
    path: string,
    headers: Record<string, string>
) {
    const file = await disk(diskName).read(path)
    if (!file) {
        // Laravel melempar FileNotFoundException (500) kalau berkas hilang di
        // antara cek exists() dan pengiriman; pemanggil sudah cek exists().
        throw Object.assign(new Error(`Berkas tidak ditemukan: ${path}`), { status: 500 })
    }

    for (const [name, value] of Object.entries(headers)) {
        ctx.response.header(name, value)
    }
    if (file.size !== null) {
        ctx.response.header('Content-Length', String(file.size))
    }
    return ctx.response.stream(file.stream)
}

/** Storage::disk('spaces')->temporaryUrl($path, now()->addMinutes(5), [...]). */
function temporaryUrl(
    path: string,
    overrides: { responseContentDisposition?: string; responseContentType?: string }
): Promise<string> {
    return disk('spaces').temporaryUrl(path, {
        expiresInSeconds: TEMPORARY_FILE_URL_MINUTES * 60,
        ...overrides,
    })
}

/**
 * $file->store($directory, $disk): nama acak 40 karakter + ekstensi dari
 * isi berkas (guessExtension()). Mengembalikan path relatif terhadap disk.
 */
export async function storeUploadedFile(
    file: MultipartFile,
    directory: string,
    diskName: DiskName
): Promise<string> {
    const extension = normalizedExtension(file.extname ?? extname(file.clientName).slice(1))
    const path = `${directory}/${randomString(40)}${extension ? `.${extension}` : ''}`
    const contents = await readFile(file.tmpPath!)
    await disk(diskName).put(path, contents, mimeTypeFor(path))
    return path
}

/** guessExtension() Symfony memberi 'jpg' untuk image/jpeg. */
function normalizedExtension(extension: string): string {
    const lower = extension.toLowerCase()
    return lower === 'jpeg' || lower === 'jpe' ? 'jpg' : lower
}

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Str::random(): huruf & angka saja. */
export function randomString(length: number): string {
    let result = ''
    for (let i = 0; i < length; i++) {
        result += ALPHANUMERIC[randomInt(ALPHANUMERIC.length)]
    }
    return result
}

const MIME_TYPES: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    apk: 'application/vnd.android.package-archive',
    exe: 'application/x-msdownload',
    zip: 'application/zip',
}

export function mimeTypeFor(path: string): string {
    return MIME_TYPES[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * HeaderUtils::makeDisposition('attachment', $name, Str::ascii($name)) Symfony:
 * nama dikutip hanya kalau ada karakter di luar token HTTP, dan nama
 * non-ASCII dikirim juga lewat filename*.
 */
export function attachmentDisposition(name: string): string {
    const fallback = toAscii(name.replaceAll('%', ''))
    let header = `attachment; filename=${quoteIfNeeded(fallback)}`
    if (fallback !== name) {
        header += `; filename*=utf-8''${rawUrlEncode(name)}`
    }
    return header
}

function quoteIfNeeded(value: string): string {
    return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)
        ? value
        : `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function rawUrlEncode(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    )
}

/** addslashes() PHP. */
function addSlashes(value: string): string {
    return value.replace(/[\\'"\0]/g, (char) => (char === '\0' ? '\\0' : `\\${char}`))
}

/** Pendekatan Str::ascii(): huruf beraksen jadi huruf dasarnya, sisanya dibuang. */
function toAscii(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\x20-\x7e]/g, '')
}

/**
 * Str::slug($title) Laravel (pemisah '-'): '_' jadi '-', '@' jadi '-at-',
 * huruf kecil, buang selain huruf/angka/spasi/'-', lalu spasi & '-' beruntun
 * jadi satu '-'.
 */
export function laravelSlug(title: string): string {
    return toAscii(title)
        .replace(/_+/g, '-')
        .replaceAll('@', '-at-')
        .toLowerCase()
        .replace(/[^-\p{L}\p{N}\s]+/gu, '')
        .replace(/[-\s]+/gu, '-')
        .replace(/^-+|-+$/g, '')
}
