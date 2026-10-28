import vine, { SimpleMessagesProvider } from '@vinejs/vine'
import db from '@adonisjs/lucid/services/db'

/**
 * Validasi modul device, padanan StoreDeviceRequest, UpdateDeviceRequest, dan
 * $request->validate() di DeviceCommandController, DeviceOtpController,
 * DeviceEnrollmentController. Pesan per field memakai teks bawaan Laravel
 * (locale 'en' di backend-api) supaya `errors` yang diterima dashboard & APK
 * tetap sama.
 */

/** Nama atribut versi Laravel: organization_id -> "organization id". */
function laravelFields(...names: string[]) {
    return Object.fromEntries(names.map((name) => [name, name.replaceAll('_', ' ')]))
}

const LARAVEL_MESSAGES = {
    required: 'The {{ field }} field is required.',
    string: 'The {{ field }} field must be a string.',
    number: 'The {{ field }} field must be an integer.',
    withoutDecimals: 'The {{ field }} field must be an integer.',
    maxLength: 'The {{ field }} field must not be greater than {{ max }} characters.',
    enum: 'The selected {{ field }} is invalid.',
    laravelBoolean: 'The {{ field }} field must be true or false.',
    exists: 'The selected {{ field }} is invalid.',
    unique: 'The {{ field }} has already been taken.',
}

/** Rule exists:table,id Laravel -- tanpa scope soft delete, sama seperti Laravel. */
const existsIn = vine.createRule<{ table: string }>(
    async (value, { table }, field) => {
        const row = await db
            .from(table)
            .where('id', value as number)
            .first()
        if (!row) field.report(LARAVEL_MESSAGES.exists, 'exists', field)
    },
    { isAsync: true }
)

/** Rule unique:table,column Laravel -- baris yang sudah di-soft-delete tetap dihitung. */
const uniqueIn = vine.createRule<{ table: string; column: string }>(
    async (value, { table, column }, field) => {
        const row = await db
            .from(table)
            .where(column, value as string)
            .first()
        if (row) field.report(LARAVEL_MESSAGES.unique, 'unique', field)
    },
    { isAsync: true }
)

/**
 * Rule boolean Laravel: hanya true, false, 0, 1, "0", "1" (lebih ketat dari
 * vine.boolean() yang juga menerima "on"/"true"). Hasilnya dijadikan boolean.
 */
export const LARAVEL_BOOLEAN_VALUES = [true, false, 0, 1, '0', '1'] as const

// implicit: ikut dijalankan untuk null, karena 'sometimes|boolean' Laravel
// menolak null (hanya field yang tidak dikirim sama sekali yang dilewati).
const laravelBoolean = vine.createRule(
    (value, _options, field) => {
        if (value === undefined) return
        if (!(LARAVEL_BOOLEAN_VALUES as readonly unknown[]).includes(value)) {
            field.report(LARAVEL_MESSAGES.laravelBoolean, 'laravelBoolean', field)
            return
        }
        field.mutate(value === true || value === 1 || value === '1', field)
    },
    { implicit: true }
)

/** 'sometimes|string|max:N': tidak dikirim boleh, null/bukan string ditolak. */
const sometimesString = vine.createRule<{ max: number }>(
    (value, { max }, field) => {
        if (value === undefined) return
        if (typeof value !== 'string') {
            field.report(LARAVEL_MESSAGES.string, 'string', field)
        } else if ([...value].length > max) {
            field.report(LARAVEL_MESSAGES.maxLength, 'maxLength', field, { max })
        }
    },
    { implicit: true }
)

/** Rule digits:N Laravel: hanya angka 0-9, tepat N karakter (angka JSON juga diterima). */
export function isDigits(value: unknown, length: number): boolean {
    if (typeof value !== 'string' && typeof value !== 'number') return false
    const text = String(value)
    return /^[0-9]+$/.test(text) && text.length === length
}

const digits = vine.createRule<{ length: number }>((value, { length }, field) => {
    if (!isDigits(value, length)) {
        field.report(`The {{ field }} field must be ${length} digits.`, 'digits', field)
        return
    }
    field.mutate(String(value), field)
})

function compile<Schema extends Parameters<typeof vine.compile>[0]>(
    schema: Schema,
    fields: string[],
    messages: Record<string, string> = {}
) {
    const validator = vine.compile(schema)
    validator.messagesProvider = new SimpleMessagesProvider(
        { ...LARAVEL_MESSAGES, ...messages },
        laravelFields(...fields)
    )
    return validator
}

export const storeDeviceValidator = compile(
    vine.object({
        organization_id: vine
            .number()
            .withoutDecimals()
            .use(existsIn({ table: 'organizations' })),
        device_name: vine.string().maxLength(255),
        device_uuid: vine
            .string()
            .maxLength(255)
            .use(uniqueIn({ table: 'devices', column: 'device_uuid' })),
        android_version: vine.string().maxLength(10),
        app_build_version: vine.string().maxLength(20),
        site_code_embedded: vine.string().maxLength(32),
    }),
    [
        'organization_id',
        'device_name',
        'device_uuid',
        'android_version',
        'app_build_version',
        'site_code_embedded',
    ]
)

/**
 * 'sometimes': boleh tidak dikirim. Dikirim null (string kosong juga jadi
 * null) tetap gagal di rule string/boolean, sama seperti Laravel -- tanpa ini
 * null lolos dari .optional() Vine dan tersimpan ke kolom NOT NULL.
 */
export const moveDeviceSiteValidator = compile(
    vine.object({
        organization_id: vine.number().withoutDecimals().positive(),
    }),
    ['organization_id']
)

export const updateDeviceValidator = compile(
    vine.object({
        device_name: vine
            .any()
            .use(sometimesString({ max: 255 }))
            .optional(),
        is_active: vine.any().use(laravelBoolean()).optional(),
    }),
    ['device_name', 'is_active']
)

export const COMMAND_TYPES = [
    'lock',
    'unlock',
    'start_monitor',
    'stop_monitor',
    'locate_now',
] as const

export const storeDeviceCommandValidator = compile(
    vine.object({
        command_type: vine.enum(COMMAND_TYPES),
        // 'system_auto' sengaja tidak termasuk di sini -- hanya gateway yang
        // menulis baris itu langsung ke DB (tidak lewat endpoint HTTP ini),
        // supaya tidak ada klien luar yang bisa menyamar sebagai sistem.
        issued_via: vine.enum(['web_dashboard', 'master_app', 'telegram_bot'] as const),
        reason_note: vine.string().maxLength(255).nullable().optional(),
    }),
    ['command_type', 'issued_via', 'reason_note']
)

export const verifyDeviceOtpValidator = compile(
    vine.object({
        device_uuid: vine.string(),
        code: vine.any().use(digits({ length: 6 })),
    }),
    ['device_uuid', 'code']
)

export const claimDeviceValidator = compile(
    vine.object({
        device_uuid: vine.string().maxLength(255),
    }),
    ['device_uuid']
)
