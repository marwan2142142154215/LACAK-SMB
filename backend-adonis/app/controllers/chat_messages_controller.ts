import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { accessOf, can } from '#services/access'
import { laravelDate } from '#services/activity_log'
import { fail, success } from '#services/api_response'
import { laravelUrlSigner } from '#services/laravel/index'
import { authorizedOrganizationId } from '#services/organization_scope'
import { serveImageFromDisk } from '#services/documents'
import { chatImagesDiskName, disk } from '#services/storage'

/**
 * Chat staf per site -- padanan ChatMessageController di backend-api. Satu
 * ruang chat = satu site; siapa yang boleh membaca & menulis memakai aturan
 * yang sama dengan Live Kerja (live.watch + cakupan site): staf hanya
 * site-nya sendiri, admin/leader site yang diberikan, super_admin semua site.
 *
 * Realtime-gateway memanggil endpoint ini dengan token user yang sedang
 * chat (bukan token sistem), jadi gateway tidak pernah memutuskan sendiri
 * siapa boleh masuk ruang chat mana. Pesan bergambar dikirim dashboard
 * langsung ke sini (multipart), lalu gateway mengambil pesan jadi lewat
 * show() sebelum menyiarkannya -- isi siaran selalu dari backend.
 */

const PAGE_SIZE = 50

/** Batas ukuran gambar (KB); dashboard sudah mengecilkan foto sebelum mengunggah. */
const MAX_IMAGE_KB = 5120

const MAX_IMAGE_SIDE = 10_000

/** Tautan gambar bertanda tangan berlaku selama ini; riwayat dimuat ulang tiap membuka chat. */
const IMAGE_URL_HOURS = 12

/** Daftar tertutup (tanpa SVG -- bisa berisi skrip), dicek dari ISI berkas. */
const IMAGE_MIMES = ['jpg', 'jpeg', 'png', 'webp', 'gif']
const IMAGE_MIMETYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

export type MessageRow = {
    id: number
    organization_id: number | null
    chat_group_id?: number | null
    user_id: number
    user_name: string | null
    reply_to_id: number | null
    body: string | null
    image_path: string | null
    image_mime: string | null
    image_width: number | null
    image_height: number | null
    created_at: Date | null
    reply_id: number | null
    reply_user_name: string | null
    reply_body: string | null
    reply_image_path: string | null
}

export default class ChatMessagesController {
    /** Riwayat pesan terbaru (urut lama -> baru); before_id untuk memuat yang lebih lama. */
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'live.watch')) return forbidden(ctx)

        const errors: ValidationErrors = {}
        const requested = integerInput(
            ctx.request.input('organization_id'),
            'organization_id',
            errors
        )
        const beforeId = integerInput(ctx.request.input('before_id'), 'before_id', errors)
        if (Object.keys(errors).length) return invalid(ctx, errors)

        const organizationId = authorizedOrganizationId(access, requested)
        if (organizationId === null) {
            return ctx.response.status(403).send(fail('Anda tidak berwenang membuka chat site ini'))
        }

        const query = messages().where('m.organization_id', organizationId)
        if (beforeId) {
            query.where('m.id', '<', beforeId)
        }
        const latest: MessageRow[] = await query.orderBy('m.id', 'desc').limit(PAGE_SIZE)
        const rows = latest.reverse()

        return success('Riwayat chat', {
            organization_id: organizationId,
            messages: rows.map((row) => toPayload(row)),
            has_more: rows.length === PAGE_SIZE,
        })
    }

    /** Satu pesan -- dipakai gateway untuk menyiarkan pesan bergambar yang baru diunggah. */
    async show(ctx: HttpContext) {
        // Route model binding Laravel: pesan yang tidak ada = 404 sebelum cek izin.
        const row = await findMessage(ctx.params.chatMessage)
        if (!row) return notFound(ctx)

        // Pesan grup: hanya anggota grupnya (lihat ChatGroupsController).
        if (row.chat_group_id) {
            const member = await db
                .from('chat_group_members')
                .where('chat_group_id', row.chat_group_id)
                .where('user_id', ctx.authUser!.id)
                .first()
            if (!member) return forbidden(ctx)
            return success('Pesan', toPayload(row))
        }

        const access = await accessOf(ctx)
        if (!can(access, 'live.watch')) return forbidden(ctx)

        if (
            row.organization_id === null ||
            authorizedOrganizationId(access, row.organization_id) !== row.organization_id
        ) {
            return ctx.response.status(403).send(fail('Anda tidak berwenang membuka chat site ini'))
        }

        return success('Pesan', toPayload(row))
    }

    async store(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'live.watch')) return forbidden(ctx)

        const errors: ValidationErrors = {}
        const requested = integerInput(
            ctx.request.input('organization_id'),
            'organization_id',
            errors
        )
        const replyToId = integerInput(ctx.request.input('reply_to_id'), 'reply_to_id', errors)
        const body = bodyInput(ctx.request.input('body'), errors)
        const image = await imageInput(ctx, errors)
        if (Object.keys(errors).length) return invalid(ctx, errors)

        if (body === '' && !image) {
            return ctx.response.status(422).send(fail('Pesan tidak boleh kosong'))
        }

        const organizationId = authorizedOrganizationId(access, requested)
        if (organizationId === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang mengirim pesan ke site ini'))
        }

        // Yang dibalas harus pesan di ruang chat yang sama.
        if (replyToId !== null) {
            const original = await db
                .from('chat_messages')
                .where('id', replyToId)
                .where('organization_id', organizationId)
                .select('id')
                .first()
            if (!original) {
                return ctx.response.status(422).send(fail('Pesan yang dibalas tidak ditemukan'))
            }
        }

        let imageAttributes = {}
        if (image) {
            const path = `chat/${organizationId}/${randomUUID()}.${image.extension}`
            try {
                await disk(chatImagesDiskName()).put(path, image.contents, image.mime)
            } catch (error) {
                logger.error({ err: error }, 'Gambar chat gagal disimpan')
                return ctx.response
                    .status(503)
                    .send(
                        fail('Gambar gagal disimpan ke penyimpanan server, coba lagi sebentar lagi')
                    )
            }
            imageAttributes = {
                image_path: path,
                image_mime: image.mime,
                image_width: image.width,
                image_height: image.height,
            }
        }

        // Kolom timestamp(0): Eloquent menyimpan tanpa pecahan detik.
        const now = new Date(Math.floor(Date.now() / 1000) * 1000)
        const [created] = await db
            .table('chat_messages')
            .insert({
                organization_id: organizationId,
                user_id: ctx.authUser!.id,
                reply_to_id: replyToId,
                body: body === '' ? null : body,
                ...imageAttributes,
                created_at: now,
                updated_at: now,
            })
            .returning('id')

        const row = (await findMessage(created.id))!
        // setRelation('user', $user): nama pengirim dari user yang sedang login.
        row.user_name = ctx.authUser!.name

        return ctx.response.status(201).send(success('Pesan terkirim', toPayload(row)))
    }

    /**
     * Gambar chat lewat tautan bertanda tangan (route tanpa auth, supaya bisa
     * dipakai langsung di <img>); tautannya dibuat hanya untuk user yang boleh
     * membaca ruang chat itu.
     */
    async image(ctx: HttpContext) {
        const row = await findMessage(ctx.params.chatMessage)
        if (!row) return notFound(ctx)

        // Middleware `signed` Laravel: tanda tangan salah = 403 pesan umum.
        if (
            !laravelUrlSigner.hasValidSignature(
                `/api/v1/chat-messages/${ctx.params.chatMessage}/image`,
                ctx.request.qs()
            )
        ) {
            return forbidden(ctx)
        }

        const diskName = chatImagesDiskName()
        const storage = disk(diskName)
        if (!row.image_path || !(await storage.exists(row.image_path))) {
            return ctx.response.status(404).send(fail('Gambar tidak ditemukan'))
        }
        const mime = row.image_mime ?? 'application/octet-stream'

        // Spaces -> alihkan ke tautan bertanda waktu; lokal -> dialirkan dengan
        // Content-Type dari tipe yang tervalidasi saat unggah + nosniff.
        return serveImageFromDisk(ctx, diskName, row.image_path, mime)
    }
}

export function messages() {
    // with(['user:id,name', 'replyTo.user:id,name']): user yang di-soft-delete
    // tidak ikut dimuat (nama jadi null), sama dengan Eloquent.
    return db
        .from('chat_messages as m')
        .leftJoin('users as u', (join) => {
            join.on('u.id', 'm.user_id').andOnNull('u.deleted_at')
        })
        .leftJoin('chat_messages as r', 'r.id', 'm.reply_to_id')
        .leftJoin('users as ru', (join) => {
            join.on('ru.id', 'r.user_id').andOnNull('ru.deleted_at')
        })
        .select(
            'm.id',
            'm.organization_id',
            'm.chat_group_id',
            'm.user_id',
            'u.name as user_name',
            'm.reply_to_id',
            'm.body',
            'm.image_path',
            'm.image_mime',
            'm.image_width',
            'm.image_height',
            'm.created_at',
            'r.id as reply_id',
            'ru.name as reply_user_name',
            'r.body as reply_body',
            'r.image_path as reply_image_path'
        )
}

export async function findMessage(id: unknown): Promise<MessageRow | null> {
    const value = String(id ?? '')
    if (!/^\d{1,18}$/.test(value)) return null
    return (await messages().where('m.id', Number(value)).first()) ?? null
}

/** ChatMessage::toPayload(): image_path tidak pernah dikirim -- hanya tautan bertanda tangan. */
export function toPayload(row: MessageRow, now: Date = new Date()) {
    const hasReply = row.reply_to_id && row.reply_id
    return {
        id: row.id,
        organization_id: row.organization_id,
        chat_group_id: row.chat_group_id ?? null,
        user_id: row.user_id,
        user_name: row.user_name,
        body: row.body,
        image: row.image_path
            ? {
                  url: laravelUrlSigner.temporarySignedUrl(
                      `/api/v1/chat-messages/${row.id}/image`,
                      new Date(now.getTime() + IMAGE_URL_HOURS * 3_600_000)
                  ),
                  width: row.image_width,
                  height: row.image_height,
              }
            : null,
        // Kutipan singkat pesan asal, cukup untuk ditampilkan di atas balasan.
        reply_to: hasReply
            ? {
                  id: row.reply_id,
                  user_name: row.reply_user_name,
                  body: row.reply_body !== null ? strLimit(row.reply_body, 140) : null,
                  has_image: row.reply_image_path !== null,
              }
            : null,
        created_at: laravelDate(row.created_at),
    }
}

/* ---------------------------------------------------------------------
 | Validasi -- pesan sama dengan validator Laravel (locale en) yang
 | dipakai backend-api, karena dashboard menampilkan errors[field][0].
 * ------------------------------------------------------------------- */

export type ValidationErrors = Record<string, string[]>

export function invalid(ctx: HttpContext, errors: ValidationErrors) {
    return ctx.response.status(422).send(fail('Isian tidak lolos validasi', errors))
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang melakukan tindakan ini'))
}

function notFound(ctx: HttpContext) {
    return ctx.response.status(404).send(fail('Data tidak ditemukan'))
}

const label = (field: string) => field.replace(/_/g, ' ')

/** Middleware TrimStrings Laravel: spasi ASCII + BOM/ZWSP/LRM di kedua ujung. */
export function laravelTrim(value: string): string {
    return value.replace(/^[ \t\n\v\f\r\uFEFF\u200B\u200E]+|[ \t\n\v\f\r\uFEFF\u200B\u200E]+$/g, '')
}

/** Aturan `nullable|integer` (FILTER_VALIDATE_INT); '' dianggap null (ConvertEmptyStringsToNull). */
export function integerInput(
    value: unknown,
    field: string,
    errors: ValidationErrors
): number | null {
    if (typeof value === 'string') value = laravelTrim(value)
    if (value === null || value === undefined || value === '') return null
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value
    if (typeof value === 'string' && /^[+-]?(0|[1-9]\d{0,17})$/.test(value)) return Number(value)
    errors[field] = [`The ${label(field)} field must be an integer.`]
    return null
}

/** `nullable|string|max:1000`, lalu trim() seperti controller Laravel. */
export function bodyInput(value: unknown, errors: ValidationErrors): string {
    if (typeof value === 'string') value = laravelTrim(value)
    if (value === null || value === undefined || value === '') return ''
    if (typeof value !== 'string') {
        errors.body = ['The body field must be a string.']
        return ''
    }
    if ([...value].length > 1000) {
        errors.body = ['The body field must not be greater than 1000 characters.']
    }
    return value
}

type UploadedImage = {
    contents: Buffer
    mime: string
    extension: string
    width: number | null
    height: number | null
}

/** Aturan image: nullable|file|mimes|mimetypes|max:5120|dimensions (tanpa bail). */
export async function imageInput(
    ctx: HttpContext,
    errors: ValidationErrors
): Promise<UploadedImage | null> {
    const file = ctx.request.file('image')
    if (!file) {
        const raw = ctx.request.input('image')
        if (raw === null || raw === undefined || raw === '') return null
        errors.image = [
            'The image field must be a file.',
            mimesMessage(IMAGE_MIMES),
            mimesMessage(IMAGE_MIMETYPES),
            'The image field has invalid image dimensions.',
        ]
        return null
    }
    if (!file.tmpPath || file.hasErrors) {
        errors.image = ['The image failed to upload.']
        return null
    }

    const contents = await readFile(file.tmpPath)
    const problems = imageErrors(contents)
    if (problems.length) {
        errors.image = problems
        return null
    }

    const info = sniffImage(contents)!
    return {
        contents,
        mime: info.mime,
        extension: info.extension,
        width: info.width,
        height: info.height,
    }
}

const mimesMessage = (values: string[]) =>
    `The image field must be a file of type: ${values.join(', ')}.`

/** Pesan validasi untuk isi berkas gambar (urutan aturan sama dengan Laravel). */
export function imageErrors(contents: Buffer): string[] {
    const info = sniffImage(contents)
    const problems: string[] = []
    if (!info) {
        problems.push(mimesMessage(IMAGE_MIMES), mimesMessage(IMAGE_MIMETYPES))
    }
    if (contents.length / 1024 > MAX_IMAGE_KB) {
        problems.push(`The image field must not be greater than ${MAX_IMAGE_KB} kilobytes.`)
    }
    if (
        !info ||
        info.width === null ||
        info.height === null ||
        info.width > MAX_IMAGE_SIDE ||
        info.height > MAX_IMAGE_SIDE
    ) {
        problems.push('The image field has invalid image dimensions.')
    }
    return problems
}

export type ImageInfo = {
    mime: string
    extension: string
    width: number | null
    height: number | null
}

/**
 * Jenis & ukuran gambar dari ISI berkas (padanan finfo + getimagesize()),
 * bukan dari nama/Content-Type kiriman klien. Hanya JPEG, PNG, GIF, WebP.
 */
export function sniffImage(buffer: Buffer): ImageInfo | null {
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return { mime: 'image/jpeg', extension: 'jpg', ...jpegSize(buffer) }
    }
    if (
        buffer.length >= 24 &&
        buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
        return {
            mime: 'image/png',
            extension: 'png',
            width: buffer.readUInt32BE(16),
            height: buffer.readUInt32BE(20),
        }
    }
    const head = buffer.subarray(0, 6).toString('latin1')
    if ((head === 'GIF87a' || head === 'GIF89a') && buffer.length >= 10) {
        return {
            mime: 'image/gif',
            extension: 'gif',
            width: buffer.readUInt16LE(6),
            height: buffer.readUInt16LE(8),
        }
    }
    if (
        buffer.length >= 16 &&
        buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
        buffer.subarray(8, 12).toString('latin1') === 'WEBP'
    ) {
        return { mime: 'image/webp', extension: 'webp', ...webpSize(buffer) }
    }
    return null
}

function jpegSize(buffer: Buffer): { width: number | null; height: number | null } {
    let offset = 2
    while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
            offset++
            continue
        }
        const marker = buffer[offset + 1]
        if (marker === 0xff) {
            offset++
            continue
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset += 2
            continue
        }
        // SOF0..SOF15 kecuali DHT (C4), JPG (C8), DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return {
                height: buffer.readUInt16BE(offset + 5),
                width: buffer.readUInt16BE(offset + 7),
            }
        }
        offset += 2 + buffer.readUInt16BE(offset + 2)
    }
    return { width: null, height: null }
}

function webpSize(buffer: Buffer): { width: number | null; height: number | null } {
    const chunk = buffer.subarray(12, 16).toString('latin1')
    if (chunk === 'VP8 ' && buffer.length >= 30) {
        return {
            width: buffer.readUInt16LE(26) & 0x3fff,
            height: buffer.readUInt16LE(28) & 0x3fff,
        }
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
        const b1 = buffer[22]
        const b2 = buffer[23]
        const b3 = buffer[24]
        return {
            width: 1 + (((b1 & 0x3f) << 8) | buffer[21]),
            height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
        }
    }
    if (chunk === 'VP8X' && buffer.length >= 30) {
        return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
    }
    return { width: null, height: null }
}

/** Lebar tampilan seperti mb_strwidth(): karakter lebar (CJK, emoji) dihitung 2. */
function charWidth(codePoint: number): number {
    const wide =
        (codePoint >= 0x1100 && codePoint <= 0x115f) ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
        (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
        (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    return wide ? 2 : 1
}

/** Str::limit($value, $limit): potong per lebar tampilan, rtrim, lalu '...'. */
export function strLimit(value: string, limit: number): string {
    const chars = [...value]
    let width = 0
    for (const char of chars) width += charWidth(char.codePointAt(0)!)
    if (width <= limit) return value

    let result = ''
    width = 0
    for (const char of chars) {
        const next = charWidth(char.codePointAt(0)!)
        if (width + next > limit) break
        result += char
        width += next
    }
    // rtrim() PHP: spasi, tab, baris baru, CR, NUL, VT.
    return result.replace(PHP_RTRIM, '') + '...'
}

const PHP_RTRIM = new RegExp('[ \t\n\r\v' + String.fromCharCode(0) + ']+$')
