import type { HttpContext } from '@adonisjs/core/http'
import vine, { SimpleMessagesProvider } from '@vinejs/vine'
import type { FieldContext } from '@vinejs/vine/types'

/**
 * Validasi modul aturan (geofence, dokumen consent, Telegram) -- padanan
 * Store*Request & $request->validate() di backend-api.
 *
 * backend-api memakai locale 'en' tanpa folder lang/, jadi isi `errors`
 * adalah pesan bawaan Laravel berbahasa Inggris dengan nama field yang
 * garis bawahnya diganti spasi ("The rule name field is required.").
 * Pesan yang sama dipakai di sini supaya dashboard menampilkan teks yang
 * sama dari kedua backend.
 */

/** Tanggal yang bisa dibaca strtotime() (aturan 'date' Laravel). */
export function parseLaravelDate(value: unknown): Date | null {
    if (typeof value !== 'string' || value.trim() === '') return null
    const trimmed = value.trim()
    // Tanggal saja (YYYY-MM-DD) dibaca sebagai tengah malam UTC, seperti
    // strtotime() dengan zona waktu aplikasi UTC (config/app.php backend-api).
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
        ? new Date(`${trimmed}T00:00:00Z`)
        : new Date(trimmed)
    return Number.isNaN(parsed.getTime()) ? null : parsed
}

const laravelDateRule = vine.createRule((value, _options, field: FieldContext) => {
    if (!field.isValid) return
    if (parseLaravelDate(value) === null) {
        field.report('The {{ field }} field must be a valid date.', 'date', field)
    }
})

/** Aturan 'after:<field lain>' Laravel: harus SETELAH tanggal field lain. */
const afterFieldRule = vine.createRule(
    (value, options: { otherField: string; label: string }, field: FieldContext) => {
        if (!field.isValid) return
        const current = parseLaravelDate(value)
        const other = parseLaravelDate(field.parent?.[options.otherField])
        if (current === null || other === null || current.getTime() <= other.getTime()) {
            field.report(
                `The {{ field }} field must be a date after ${options.label}.`,
                'after',
                field
            )
        }
    }
)

/**
 * Aturan 'boolean' Laravel: hanya true, false, 0, 1, "0", "1" (vine.boolean()
 * juga menerima "on"/"true"). Hasilnya dijadikan boolean.
 */
const laravelBooleanRule = vine.createRule((value, _options, field: FieldContext) => {
    if (![true, false, 0, 1, '0', '1'].includes(value as never)) {
        field.report('The {{ field }} field must be true or false.', 'boolean', field)
        return
    }
    field.mutate(value === true || value === 1 || value === '1', field)
})

/** Nama field ala Laravel: garis bawah jadi spasi. */
function attributeNames(fields: string[]): Record<string, string> {
    return Object.fromEntries(fields.map((name) => [name, name.replaceAll('_', ' ')]))
}

const LARAVEL_MESSAGES: Record<string, string> = {
    'required': 'The {{ field }} field is required.',
    'string': 'The {{ field }} field must be a string.',
    'maxLength': 'The {{ field }} field must not be greater than {{ max }} characters.',
    'number': 'The {{ field }} field must be a number.',
    'withoutDecimals': 'The {{ field }} field must be an integer.',
    'min': 'The {{ field }} field must be at least {{ min }}.',
    'range': 'The {{ field }} field must be between {{ min }} and {{ max }}.',
    'boolean': 'The {{ field }} field must be true or false.',
    'enum': 'The selected {{ field }} is invalid.',
    'database.exists': 'The selected {{ field }} is invalid.',
    'file': 'The {{ field }} field must be a file.',
}

/** Field 'integer' Laravel: pesan tipe-nya "must be an integer", bukan "a number". */
function messagesFor(
    fields: string[],
    integerFields: string[],
    extra: Record<string, string> = {}
) {
    const integerMessages = Object.fromEntries(
        integerFields.map((name) => [
            `${name}.number`,
            `The ${name.replaceAll('_', ' ')} field must be an integer.`,
        ])
    )
    return new SimpleMessagesProvider(
        { ...LARAVEL_MESSAGES, ...integerMessages, ...extra },
        attributeNames(fields)
    )
}

const integerId = () => vine.number().withoutDecimals()

// --- Geofence ---------------------------------------------------------------

export const storeGeofenceRuleValidator = vine.compile(
    vine.object({
        organization_id: integerId().exists({ table: 'organizations', column: 'id' }),
        rule_name: vine.string().maxLength(255),
        allowed_ssid: vine.string().maxLength(255).nullable().optional(),
        allowed_ip_cidr: vine.string().maxLength(50).nullable().optional(),
        max_distance_meters: integerId().min(1).nullable().optional(),
        // Radius GPS dari titik pusat -- alternatif longgar dari mode BLE.
        center_latitude: vine.number().range([-90, 90]).nullable().optional(),
        center_longitude: vine.number().range([-180, 180]).nullable().optional(),
        // Mode BLE (presisi, butuh device anchor fisik di lokasi).
        anchor_device_id: integerId()
            .exists({ table: 'devices', column: 'id' })
            .nullable()
            .optional(),
    })
)
storeGeofenceRuleValidator.messagesProvider = messagesFor(
    [
        'organization_id',
        'rule_name',
        'allowed_ssid',
        'allowed_ip_cidr',
        'max_distance_meters',
        'center_latitude',
        'center_longitude',
        'anchor_device_id',
    ],
    ['organization_id', 'max_distance_meters', 'anchor_device_id']
)

/** Semua field 'sometimes' -- yang tidak dikirim tidak diubah. */
export const updateGeofenceRuleValidator = vine.compile(
    vine.object({
        rule_name: vine.string().maxLength(255).optional(),
        allowed_ssid: vine.string().maxLength(255).nullable().optional(),
        allowed_ip_cidr: vine.string().maxLength(50).nullable().optional(),
        max_distance_meters: integerId().min(1).nullable().optional(),
        center_latitude: vine.number().range([-90, 90]).nullable().optional(),
        center_longitude: vine.number().range([-180, 180]).nullable().optional(),
        anchor_device_id: integerId()
            .exists({ table: 'devices', column: 'id' })
            .nullable()
            .optional(),
        is_active: vine.any().use(laravelBooleanRule()).optional(),
    })
)
updateGeofenceRuleValidator.messagesProvider = messagesFor(
    [
        'rule_name',
        'allowed_ssid',
        'allowed_ip_cidr',
        'max_distance_meters',
        'center_latitude',
        'center_longitude',
        'anchor_device_id',
        'is_active',
    ],
    ['max_distance_meters', 'anchor_device_id']
)

// --- Dokumen consent --------------------------------------------------------

export const SIGNER_ROLES = ['hrd', 'leader', 'asisten_manager', 'manager', 'cs_line'] as const

/** Batas berkas consent (standar 6.3): PDF atau foto scan, maks 10MB. */
export const CONSENT_FILE_EXTNAMES = ['pdf', 'jpg', 'jpeg', 'png']
export const CONSENT_FILE_MAX_KB = 10240

export const storeConsentDocumentValidator = vine.compile(
    vine.object({
        organization_id: integerId().exists({ table: 'organizations', column: 'id' }),
        subject_name: vine.string().maxLength(255),
        signer_name: vine.string().maxLength(255),
        signer_role: vine.enum(SIGNER_ROLES),
        document_file: vine.file({
            size: `${CONSENT_FILE_MAX_KB}kb`,
            extnames: CONSENT_FILE_EXTNAMES,
        }),
        signed_at: vine.string().use(laravelDateRule()),
        valid_until: vine
            .string()
            .use(laravelDateRule())
            .use(afterFieldRule({ otherField: 'signed_at', label: 'signed at' }))
            .nullable()
            .optional(),
    })
)
storeConsentDocumentValidator.messagesProvider = messagesFor(
    [
        'organization_id',
        'subject_name',
        'signer_name',
        'signer_role',
        'document_file',
        'signed_at',
        'valid_until',
    ],
    ['organization_id'],
    {
        'file.extname': `The {{ field }} field must be a file of type: ${CONSENT_FILE_EXTNAMES.join(', ')}.`,
        'file.size': `The {{ field }} field must not be greater than ${CONSENT_FILE_MAX_KB} kilobytes.`,
    }
)

// --- Telegram ---------------------------------------------------------------

export const storeTelegramBindingValidator = vine.compile(
    vine.object({
        organization_id: integerId().exists({ table: 'organizations', column: 'id' }),
        telegram_chat_id: vine.string().maxLength(255),
        // Referensi ke secret manager/.env (standar 6.1) -- bukan token asli.
        bot_token_ref: vine.string().maxLength(255),
    })
)
storeTelegramBindingValidator.messagesProvider = messagesFor(
    ['organization_id', 'telegram_chat_id', 'bot_token_ref'],
    ['organization_id']
)

export const storeTelegramUserLinkValidator = vine.compile(
    vine.object({
        // exists:users,id Laravel tidak menyaring soft delete -- sama di sini.
        user_id: integerId().exists({ table: 'users', column: 'id' }),
        telegram_user_id: vine.string().maxLength(32),
        telegram_username: vine.string().maxLength(255).nullable().optional(),
    })
)
storeTelegramUserLinkValidator.messagesProvider = messagesFor(
    ['user_id', 'telegram_user_id', 'telegram_username'],
    ['user_id']
)

// --- Query daftar -----------------------------------------------------------

/** intval() PHP untuk $request->integer(): "12abc" -> 12, "abc" -> 0. */
export function phpInteger(value: unknown, fallback = 0): number {
    if (value === undefined || value === null) return fallback
    if (typeof value === 'boolean') return value ? 1 : 0
    const parsed = Number.parseInt(String(value).trim(), 10)
    return Number.isNaN(parsed) ? 0 : parsed
}

/** `$request->integer('organization_id') ?: null`. */
export function requestedOrganizationId(ctx: HttpContext): number | null {
    return phpInteger(ctx.request.input('organization_id')) || null
}

/**
 * Halaman & ukuran halaman seperti ->paginate($request->integer('per_page', N)):
 * per_page 0/tidak terbaca = 15 (perPage bawaan Eloquent); page yang bukan
 * bilangan bulat >= 1 = halaman 1.
 */
export function paginationOf(ctx: HttpContext, defaultPerPage: number) {
    return paginationFrom(ctx.request.input('page'), ctx.request.input('per_page'), defaultPerPage)
}

export function paginationFrom(page: unknown, perPage: unknown, defaultPerPage: number) {
    const size = phpInteger(perPage, defaultPerPage)
    const pageText =
        typeof page === 'number' ? String(page) : typeof page === 'string' ? page.trim() : ''
    const pageNumber = /^[+-]?\d+$/.test(pageText) ? Number.parseInt(pageText, 10) : 1
    return {
        page: pageNumber >= 1 ? pageNumber : 1,
        // Negatif membuat backend-api gagal SQL (LIMIT negatif); di sini
        // diperlakukan sama seperti 0.
        perPage: size > 0 ? size : 15,
    }
}
