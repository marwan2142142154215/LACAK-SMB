import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import vine from '@vinejs/vine'
import type { FieldContext, MessagesProviderContact } from '@vinejs/vine/types'

/*
|--------------------------------------------------------------------------
| Validasi gaya Laravel untuk modul staf, site & pengaturan
|--------------------------------------------------------------------------
|
| Dashboard menampilkan pesan error validasi apa adanya dari backend, jadi
| pesannya disamakan dengan bawaan Laravel (bahasa Inggris -- backend-api
| tidak punya folder lang/, APP_LOCALE=en). Input juga disiapkan seperti
| middleware global Laravel (TrimStrings + ConvertEmptyStringsToNull)
| sebelum divalidasi, supaya "  " dan "" diperlakukan sama seperti di sana.
|
*/

/** Pesan validasi bawaan Laravel (lang/en/validation.php) per aturan VineJS. */
const LARAVEL_MESSAGES: Record<string, string> = {
    required: 'The :attribute field is required.',
    string: 'The :attribute field must be a string.',
    maxLength: 'The :attribute field must not be greater than :max characters.',
    minLength: 'The :attribute field must be at least :min characters.',
    email: 'The :attribute field must be a valid email address.',
    enum: 'The selected :attribute is invalid.',
    number: 'The :attribute field must be an integer.',
    withoutDecimals: 'The :attribute field must be an integer.',
    array: 'The :attribute field must be an array.',
    boolean: 'The :attribute field must be true or false.',
    unique: 'The :attribute has already been taken.',
    exists: 'The selected :attribute is invalid.',
}

/**
 * Nama field seperti getDisplayableAttribute() Laravel: snake_case dengan
 * garis bawah jadi spasi ("organization_id" -> "organization id",
 * "site_access.0" -> "site access.0").
 */
export function laravelAttributeName(path: string): string {
    return path.replace(/_/g, ' ')
}

export function laravelMessage(rule: string, path: string, args: Record<string, unknown> = {}) {
    const template = LARAVEL_MESSAGES[rule]
    if (!template) {
        return null
    }
    return template
        .replace(':attribute', laravelAttributeName(path))
        .replace(/:(max|min)\b/g, (_, key: string) => String(args[key] ?? ''))
}

export class LaravelMessagesProvider implements MessagesProviderContact {
    getMessage(
        defaultMessage: string,
        rule: string,
        field: FieldContext,
        args?: Record<string, any>
    ): string {
        return laravelMessage(rule, field.getFieldPath(), args) ?? defaultMessage
    }
}

export const laravelMessages = new LaravelMessagesProvider()

/*
|--------------------------------------------------------------------------
| Persiapan input (TrimStrings + ConvertEmptyStringsToNull)
|--------------------------------------------------------------------------
*/

/** Field yang TIDAK di-trim oleh TrimStrings bawaan Laravel. */
const NOT_TRIMMED = new Set(['current_password', 'password', 'password_confirmation'])

/**
 * Penanda "field dikirim tapi isinya null" untuk aturan `sometimes` tanpa
 * `nullable`: Laravel tetap memvalidasinya (mis. name=null -> "must be a
 * string"), sedangkan VineJS optional() diam-diam membuang null. Nilai ini
 * pasti gagal di cek tipe string/enum/boolean, jadi pesannya sama.
 */
export const PRESENT_NULL = Symbol('present-null')

/** trim() PHP: hanya spasi, \t, \n, \r, \0, \x0B -- bukan semua spasi Unicode. */
const PHP_TRIM_CHARS = new Set([' ', '\t', '\n', '\r', '\0', '\u000B'])

export function phpTrim(value: string): string {
    let start = 0
    let end = value.length
    while (start < end && PHP_TRIM_CHARS.has(value[start])) start++
    while (end > start && PHP_TRIM_CHARS.has(value[end - 1])) end--
    return value.slice(start, end)
}

function prepareValue(key: string, value: unknown): unknown {
    if (typeof value === 'string') {
        const trimmed = NOT_TRIMMED.has(key) ? value : phpTrim(value)
        return trimmed === '' ? null : trimmed
    }
    if (Array.isArray(value)) {
        return value.map((item, index) => prepareValue(`${key}.${index}`, item))
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([childKey, child]) => [
                childKey,
                prepareValue(`${key}.${childKey}`, child),
            ])
        )
    }
    return value
}

type PrepareOptions = {
    /** Aturan `sometimes` tanpa `nullable`: null yang dikirim tetap divalidasi. */
    sometimes?: string[]
    /** Aturan `required` pada array: [] dianggap kosong, sama seperti Laravel. */
    requiredArrays?: string[]
}

/** Input request (query + body, body menang) yang sudah disiapkan seperti Laravel. */
export function laravelPrepare(
    input: Record<string, unknown>,
    options: PrepareOptions = {}
): Record<string, unknown> {
    const data: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
        data[key] = prepareValue(key, value)
    }
    for (const key of options.sometimes ?? []) {
        if (key in data && data[key] === null) {
            data[key] = PRESENT_NULL
        }
    }
    for (const key of options.requiredArrays ?? []) {
        if (Array.isArray(data[key]) && (data[key] as unknown[]).length === 0) {
            delete data[key]
        }
    }
    return data
}

export function laravelInput(ctx: HttpContext, options: PrepareOptions = {}) {
    return laravelPrepare(ctx.request.all(), options)
}

/*
|--------------------------------------------------------------------------
| Pembacaan query seperti $request->integer() / boolean() / paginate()
|--------------------------------------------------------------------------
*/

/** intval() PHP untuk nilai dari request. */
export function phpIntval(value: unknown): number {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? Math.trunc(value) : 0
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0
    }
    if (typeof value === 'string') {
        const match = value.match(/^[ \t\n\r\v\f]*([+-]?\d+)/)
        return match ? Number.parseInt(match[1], 10) : 0
    }
    if (Array.isArray(value)) {
        return value.length > 0 ? 1 : 0
    }
    return 0
}

/** filter_var($value, FILTER_VALIDATE_BOOLEAN): "1", "true", "on", "yes" = true. */
export function phpBooleanFlag(value: unknown): boolean {
    if (typeof value === 'boolean') {
        return value
    }
    if (typeof value === 'number') {
        return value === 1
    }
    if (typeof value === 'string') {
        return ['1', 'true', 'on', 'yes'].includes(phpTrim(value).toLowerCase())
    }
    return false
}

/** $request->integer($key, $default): default hanya kalau key tidak dikirim. */
export function requestInteger(input: Record<string, unknown>, key: string, fallback = 0): number {
    return key in input ? phpIntval(input[key]) : fallback
}

/**
 * Jumlah per halaman untuk paginate($perPage): 0 jatuh ke bawaan model
 * Eloquent (15). Laravel melempar error SQL untuk angka negatif; di sini
 * disamakan dengan 0 supaya tidak jadi 500.
 */
export function perPageOf(input: Record<string, unknown>, fallback: number): number {
    const perPage = requestInteger(input, 'per_page', fallback)
    return perPage > 0 ? perPage : 15
}

/** Paginator::resolveCurrentPage(): bilangan bulat >= 1, selain itu halaman 1. */
export function pageOf(input: Record<string, unknown>): number {
    const raw = input.page
    if (typeof raw === 'number') {
        return Number.isInteger(raw) && raw >= 1 ? raw : 1
    }
    if (typeof raw === 'string' && /^[+-]?(0|[1-9]\d*)$/.test(phpTrim(raw))) {
        const page = Number.parseInt(phpTrim(raw), 10)
        return page >= 1 ? page : 1
    }
    return 1
}

/** lastPage() LengthAwarePaginator: minimal 1. */
export function lastPageOf(total: number, perPage: number): number {
    return Math.max(Math.ceil(total / perPage), 1)
}

/*
|--------------------------------------------------------------------------
| Aturan database (unique / exists) & boolean Laravel
|--------------------------------------------------------------------------
*/

type UniqueOptions = { table: string; column: string; ignoreIdMetaKey?: string }

/**
 * `unique:table,column` -- sama seperti Laravel, baris yang di-soft-delete
 * IKUT dihitung (username/email bekas staf terhapus tetap tidak bisa dipakai,
 * dan memang ada unique index di database).
 */
export const uniqueRule = vine.createRule<UniqueOptions>(
    async (value, options, field) => {
        const query = db.from(options.table).where(options.column, value as string)
        const ignoreId = options.ignoreIdMetaKey ? field.meta[options.ignoreIdMetaKey] : undefined
        if (ignoreId !== undefined && ignoreId !== null) {
            query.whereNot('id', ignoreId)
        }
        if (await query.first()) {
            field.report(LARAVEL_MESSAGES.unique, 'unique', field)
        }
    },
    { name: 'unique', isAsync: true }
)

/** `exists:organizations,id` -- termasuk site yang sudah di-soft-delete, sama seperti Laravel. */
export const existsRule = vine.createRule<{ table: string; column: string }>(
    async (value, options, field) => {
        const row = await db
            .from(options.table)
            .where(options.column, value as number)
            .first()
        if (!row) {
            field.report(LARAVEL_MESSAGES.exists, 'exists', field)
        }
    },
    { name: 'exists', isAsync: true }
)

const LARAVEL_BOOLEANS = [true, false, 0, 1, '0', '1']

/** Aturan `boolean` Laravel: hanya true, false, 0, 1, "0", "1". */
export const laravelBooleanRule = vine.createRule((value, _options, field) => {
    if (!LARAVEL_BOOLEANS.includes(value as never)) {
        field.report(LARAVEL_MESSAGES.boolean, 'boolean', field)
        return
    }
    field.mutate(value === true || value === 1 || value === '1', field)
})

/** Field boolean gaya Laravel (hasilnya sudah boolean). */
export function laravelBoolean() {
    return vine.any().use(laravelBooleanRule())
}

/*
|--------------------------------------------------------------------------
| StoreUserRequest / UpdateUserRequest / syncSiteAccess
|--------------------------------------------------------------------------
*/

/**
 * Peran yang boleh diberikan lewat dashboard. telegram_bot_service tetap
 * tidak termasuk -- akun layanan bot satu-satunya (TelegramBotAccountSeeder).
 */
export const ASSIGNABLE_ROLES = ['super_admin', 'admin', 'leader', 'site_admin', 'staff_viewer']

const organizationIdField = () =>
    vine
        .number()
        .withoutDecimals()
        .use(existsRule({ table: 'organizations', column: 'id' }))

export const storeUserValidator = vine.create({
    name: vine.string().maxLength(255),
    // Username sudah huruf kecil saat dicek unique (prepareForValidation),
    // supaya "Budi" tidak bisa dibuat kalau "budi" sudah ada.
    username: vine
        .string()
        .maxLength(255)
        .use(uniqueRule({ table: 'users', column: 'username' })),
    email: vine
        .string()
        .email({ require_tld: false })
        .maxLength(255)
        .use(uniqueRule({ table: 'users', column: 'email' })),
    password: vine.string().minLength(8),
    role: vine.enum(ASSIGNABLE_ROLES),
    // organization_id = site "rumah" staf (dipakai site_admin/staff_viewer);
    // admin/leader dibatasi lewat site_access, bukan field ini.
    organization_id: organizationIdField().nullable().optional(),
    site_access: vine.array(organizationIdField()).nullable().optional(),
})

export const updateUserValidator = vine.withMetaData<{ userId: number }>().create({
    name: vine.string().maxLength(255).optional(),
    email: vine
        .string()
        .email({ require_tld: false })
        .maxLength(255)
        .use(uniqueRule({ table: 'users', column: 'email', ignoreIdMetaKey: 'userId' }))
        .optional(),
    password: vine.string().minLength(8).optional(),
    role: vine.enum(ASSIGNABLE_ROLES).optional(),
    organization_id: organizationIdField().nullable().optional(),
})

/** Field `sometimes` tanpa `nullable` di UpdateUserRequest. */
export const UPDATE_USER_SOMETIMES = ['name', 'email', 'password', 'role']

export const syncSiteAccessValidator = vine.create({
    organization_ids: vine.array(organizationIdField()),
})

/** mb_strtolower(trim()) -- username selalu disimpan huruf kecil. */
export function normalizeUsername(value: unknown): unknown {
    return typeof value === 'string' ? phpTrim(value).toLowerCase() : value
}

/** Input StoreUserRequest setelah prepareForValidation(). */
export function storeUserInput(input: Record<string, unknown>): Record<string, unknown> {
    // Middleware TrimStrings/ConvertEmptyStringsToNull sudah jalan sebelum
    // prepareForValidation(), jadi username dinormalkan dari hasil persiapan.
    const data = laravelPrepare(input)
    if (typeof data.username === 'string') {
        data.username = normalizeUsername(data.username)
    }
    return data
}
