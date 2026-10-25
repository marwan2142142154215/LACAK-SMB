import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import type { NextFn } from '@adonisjs/core/types/http'
import db from '@adonisjs/lucid/services/db'
import { endBatch, startBatch, writeActivity } from '#services/activity_log'

/**
 * Log aktivitas sistem (audit trail) -- padanan RecordApiActivity di
 * backend-api: setiap aksi yang MENGUBAH sesuatu lewat API (login, kelola
 * staf, kunci device, aturan, build APK, pengaturan, dst.) dicatat beserta
 * pelaku, objek, site, hasil (berhasil / ditolak / gagal), IP & perangkat.
 *
 * Perubahan data yang terjadi dalam permintaan yang sama (logModelEvent())
 * digabung ke catatan ini lewat batch_uuid, jadi di menu Log aktivitas tampil
 * satu baris dengan rincian "sebelum -> sesudah".
 *
 * Sengaja TIDAK dicatat: log jam kerja (Live Kerja punya log sendiri), isi
 * chat, dan permintaan baca (GET).
 *
 * Didaftarkan lewat router.use() (berlaku untuk semua route, termasuk route
 * auth publik). Urutan middleware Laravel ditiru: permintaan yang ditolak
 * auth:sanctum, throttle, atau route model binding (404) TIDAK dicatat,
 * karena di backend-api middleware itu berjalan sebelum RecordApiActivity.
 */

export const LOG_NAME = 'api'

/** Model Laravel -> tabel (dipakai juga oleh menu Log aktivitas). */
export const MODEL_MORPHS = {
    User: 'App\\Models\\User',
    Device: 'App\\Models\\Device',
    GeofenceRule: 'App\\Models\\GeofenceRule',
    ConsentDocument: 'App\\Models\\ConsentDocument',
    Organization: 'App\\Models\\Organization',
    ApkBuild: 'App\\Models\\ApkBuild',
    TelegramBinding: 'App\\Models\\TelegramBinding',
    TelegramUserLink: 'App\\Models\\TelegramUserLink',
    AppSetting: 'App\\Models\\AppSetting',
    WorkSession: 'App\\Models\\WorkSession',
} as const

export type ModelName = keyof typeof MODEL_MORPHS

/** Tabel tiap model; softDeletes = Eloquent SoftDeletes (baris terhapus dianggap tidak ada). */
export const MODEL_TABLES: Record<ModelName, { table: string; softDeletes: boolean }> = {
    User: { table: 'users', softDeletes: true },
    Device: { table: 'devices', softDeletes: true },
    GeofenceRule: { table: 'geofence_rules', softDeletes: false },
    ConsentDocument: { table: 'consent_documents', softDeletes: false },
    Organization: { table: 'organizations', softDeletes: true },
    ApkBuild: { table: 'apk_builds', softDeletes: false },
    TelegramBinding: { table: 'telegram_bindings', softDeletes: false },
    TelegramUserLink: { table: 'telegram_user_links', softDeletes: false },
    AppSetting: { table: 'app_settings', softDeletes: false },
    WorkSession: { table: 'work_sessions', softDeletes: false },
}

/** Satu baris tabel model (seperti atribut Eloquent). */
export type ModelRow = Record<string, unknown> & { id: number }

type Subject = { model: ModelName; row: ModelRow }

/** Input permintaan yang sudah dirapikan seperti TrimStrings + ConvertEmptyStringsToNull. */
export type RequestInput = Record<string, unknown>

type Describe = (
    input: RequestInput,
    subject: ModelRow | null,
    status: number,
    data: Record<string, unknown> | null
) => string

type Action = {
    /** "Controller@method" Laravel -- disimpan di kolom event. */
    action: string
    category: string
    describe: Describe
}

const ok = (status: number) => status < 300

/** $model?->getAttribute($attribute) ?? $fallback, dipakai dalam kalimat. */
const name = (model: ModelRow | null, attribute: string, fallback = '') =>
    phpString(model?.[attribute] ?? fallback)

/** "$x" di PHP: null -> '', true -> '1', false -> ''. */
function phpString(value: unknown): string {
    if (value === null || value === undefined || value === false) return ''
    if (value === true) return '1'
    if (typeof value === 'object') return 'Array'
    return String(value)
}

/** $request->filled(): ada dan tidak kosong. */
function filled(value: unknown): boolean {
    if (value === null || value === undefined) return false
    if (typeof value === 'string') return value.trim() !== ''
    if (Array.isArray(value)) return value.length > 0
    return true
}

/** $request->boolean(). */
function boolean(value: unknown): boolean {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value === 1
    if (typeof value === 'string') return ['1', 'true', 'on', 'yes'].includes(value.toLowerCase())
    return false
}

/** mb_strimwidth($value, 0, $width, '…'): lebar total termasuk tanda potong. */
export function strimwidth(value: string, width: number): string {
    const chars = [...value]
    if (chars.length <= width) return value
    return chars.slice(0, width - 1).join('') + '…'
}

export function roleLabel(role: unknown): string {
    switch (role) {
        case 'super_admin':
            return 'Super Admin'
        case 'admin':
            return 'Admin'
        case 'leader':
            return 'Leader'
        case 'site_admin':
            return 'Admin Site'
        case 'staff_viewer':
            return 'Staf'
        default:
            return phpString(role)
    }
}

export function commandLabel(command: unknown): string {
    switch (command) {
        case 'lock':
            return 'Mengunci'
        case 'unlock':
            return 'Membuka kunci'
        case 'locate_now':
            return 'Meminta lokasi'
        case 'start_monitor':
            return 'Mulai memantau'
        case 'stop_monitor':
            return 'Berhenti memantau'
        default:
            return `Perintah ${phpString(command)} ke`
    }
}

export function apkLabel(type: unknown): string {
    switch (type) {
        case 'tracker':
            return 'SMB Pelacak'
        case 'master':
            return 'SMB Admin'
        case 'live':
            return 'SMB Live Kerja'
        case 'server':
            return 'Server (lacak-server.exe)'
        default:
            return 'APK'
    }
}

/**
 * Aksi yang dicatat: "<METHOD> <pola route Adonis>" => definisi. Pola memakai
 * nama parameter route Laravel (php artisan route:list --path=api); resource
 * update Laravel menerima PUT dan PATCH. Kalimat dibuat dari objek & input
 * yang aman (tanpa password/token/berkas).
 */
const ACTION_LIST: Array<[string[], string, string, Describe]> = [
    // ---- Akun & login
    [
        ['POST /api/v1/auth/login'],
        'AuthController@login',
        'auth',
        (r, _m, s, d) => {
            if (ok(s) && d?.requires_2fa) return 'Password benar, menunggu kode 2FA'
            if (ok(s) && d?.requires_2fa_setup) return 'Password benar, diminta memasang 2FA'
            if (ok(s)) return 'Login berhasil'
            if (s === 403) return 'Login ditolak: akun nonaktif / belum terdaftar'
            if (s === 429) return 'Login diblokir sementara: terlalu banyak percobaan'
            return `Login gagal: username atau password salah (${phpString(r.username).trim()})`
        },
    ],
    [
        ['POST /api/v1/auth/2fa/verify'],
        'AuthController@verifyTwoFactor',
        'auth',
        (_r, _m, s) => (ok(s) ? 'Login berhasil (kode 2FA benar)' : 'Kode 2FA salah / kedaluwarsa'),
    ],
    [
        ['POST /api/v1/auth/2fa/setup/confirm'],
        'AuthController@confirmTwoFactorSetup',
        'auth',
        (_r, _m, s) => (ok(s) ? 'Memasang authenticator 2FA' : 'Gagal memasang 2FA: kode salah'),
    ],
    [['POST /api/v1/auth/logout'], 'AuthController@logout', 'auth', () => 'Logout'],

    // ---- Staf
    [
        ['POST /api/v1/users'],
        'UserController@store',
        'staf',
        (r) => `Menambah staf ${phpString(r.username)} sebagai ${roleLabel(r.role)}`,
    ],
    [
        ['PUT /api/v1/users/:user', 'PATCH /api/v1/users/:user'],
        'UserController@update',
        'staf',
        (r, m) =>
            filled(r.password)
                ? `Mengganti password staf ${name(m, 'username')}`
                : `Mengubah data staf ${name(m, 'username')}` +
                  (filled(r.role) ? ` (peran: ${roleLabel(r.role)})` : ''),
    ],
    [
        ['DELETE /api/v1/users/:user'],
        'UserController@destroy',
        'staf',
        (_r, m) => `Menghapus staf ${name(m, 'username')}`,
    ],
    [
        ['POST /api/v1/users/:user/suspend'],
        'UserController@suspend',
        'staf',
        (_r, m) => `Menyuspen akun ${name(m, 'username')}`,
    ],
    [
        ['POST /api/v1/users/:user/reactivate'],
        'UserController@reactivate',
        'staf',
        (_r, m) => `Mengaktifkan kembali akun ${name(m, 'username')}`,
    ],
    [
        ['POST /api/v1/users/:user/reset-2fa'],
        'UserController@reset2fa',
        'staf',
        (_r, m) => `Mereset 2FA ${name(m, 'username')}`,
    ],
    [
        ['PUT /api/v1/users/:user/site-access'],
        'UserController@syncSiteAccess',
        'staf',
        (_r, m) => `Mengubah akses site ${name(m, 'username')}`,
    ],

    // ---- Device & perintah
    [
        ['POST /api/v1/devices'],
        'DeviceController@store',
        'device',
        (r) => `Mendaftarkan device ${phpString(r.device_name)}`,
    ],
    [
        ['PUT /api/v1/devices/:device', 'PATCH /api/v1/devices/:device'],
        'DeviceController@update',
        'device',
        (_r, m) => `Mengubah device ${name(m, 'device_name')}`,
    ],
    [
        ['DELETE /api/v1/devices/:device'],
        'DeviceController@destroy',
        'device',
        (_r, m) => `Menghapus device ${name(m, 'device_name')}`,
    ],
    [
        ['POST /api/v1/devices/:device/re-enroll'],
        'DeviceEnrollmentController@reEnroll',
        'device',
        (_r, m) => `Mendaftar ulang device ${name(m, 'device_name')}`,
    ],
    [
        ['POST /api/v1/device-enrollments/claim'],
        'DeviceEnrollmentController@claim',
        'device',
        (_r, _m, s) =>
            ok(s)
                ? 'Aplikasi di perangkat mengambil kunci akses (pendaftaran)'
                : 'Klaim pendaftaran perangkat ditolak',
    ],
    [
        ['POST /api/v1/devices/:device/commands'],
        'DeviceCommandController@store',
        'perintah',
        (r, m) =>
            `${commandLabel(r.command_type)} ${name(m, 'device_name')}` +
            (filled(r.reason_note) ? ` — ${strimwidth(phpString(r.reason_note), 80)}` : ''),
    ],
    [
        ['POST /api/v1/devices/:device/otp'],
        'DeviceOtpController@generate',
        'perintah',
        (_r, m) => `Membuat OTP buka kunci untuk ${name(m, 'device_name')}`,
    ],
    [
        ['POST /api/v1/device-otp/verify'],
        'DeviceOtpController@verify',
        'perintah',
        (_r, _m, s) => (ok(s) ? 'Device dibuka dengan OTP' : 'OTP buka kunci salah / kedaluwarsa'),
    ],

    // ---- Aturan & consent
    [
        ['POST /api/v1/geofence-rules'],
        'GeofenceRuleController@store',
        'aturan',
        (r) => `Membuat aturan geofence ${phpString(r.rule_name)}`,
    ],
    [
        [
            'PUT /api/v1/geofence-rules/:geofence_rule',
            'PATCH /api/v1/geofence-rules/:geofence_rule',
        ],
        'GeofenceRuleController@update',
        'aturan',
        (_r, m) => `Mengubah aturan geofence ${name(m, 'rule_name')}`,
    ],
    [
        ['DELETE /api/v1/geofence-rules/:geofence_rule'],
        'GeofenceRuleController@destroy',
        'aturan',
        (_r, m) => `Menghapus aturan geofence ${name(m, 'rule_name')}`,
    ],
    [
        ['POST /api/v1/consent-documents'],
        'ConsentDocumentController@store',
        'aturan',
        (r) => `Mengunggah dokumen consent ${phpString(r.subject_name)}`,
    ],
    [
        ['POST /api/v1/consent-documents/:consentDocument/revoke'],
        'ConsentDocumentController@revoke',
        'aturan',
        (_r, m) => `Mencabut consent ${name(m, 'subject_name')}`,
    ],

    // ---- Build APK
    [
        ['POST /api/v1/apk-builds/generate'],
        'ApkBuildController@generate',
        'apk',
        (r) =>
            `Membuat build ${apkLabel(r.apk_type)}` +
            (filled(r.version) ? ` v${phpString(r.version)}` : '') +
            (filled(r.device_name) ? ` untuk ${phpString(r.device_name)}` : ''),
    ],
    [
        ['POST /api/v1/apk-builds'],
        'ApkBuildController@store',
        'apk',
        (r) => 'Mengunggah APK manual' + (filled(r.version) ? ` v${phpString(r.version)}` : ''),
    ],
    [
        ['DELETE /api/v1/apk-builds/:apk_build'],
        'ApkBuildController@destroy',
        'apk',
        (_r, m) => 'Menghapus build APK' + (m ? ` v${name(m, 'version')}` : ''),
    ],

    // ---- Telegram
    [
        ['POST /api/v1/telegram-bindings'],
        'TelegramBindingController@store',
        'telegram',
        (r) => `Menghubungkan grup Telegram ${phpString(r.telegram_chat_id)}`,
    ],
    [
        ['DELETE /api/v1/telegram-bindings/:telegram_binding'],
        'TelegramBindingController@destroy',
        'telegram',
        (_r, m) => `Melepas grup Telegram ${name(m, 'telegram_chat_id')}`,
    ],
    [
        ['POST /api/v1/telegram-user-links'],
        'TelegramUserLinkController@store',
        'telegram',
        (r) => `Menautkan Telegram ${phpString(r.telegram_user_id)} ke akun staf`,
    ],
    [
        ['DELETE /api/v1/telegram-user-links/:telegram_user_link'],
        'TelegramUserLinkController@destroy',
        'telegram',
        () => 'Menghapus tautan Telegram staf',
    ],

    // ---- Site & pengaturan
    [
        ['POST /api/v1/organizations'],
        'OrganizationController@store',
        'site',
        (r) => `Membuat site ${phpString(r.name)}`,
    ],
    [
        ['PUT /api/v1/organizations/:organization', 'PATCH /api/v1/organizations/:organization'],
        'OrganizationController@update',
        'site',
        (_r, m) => `Mengubah site ${name(m, 'name')}`,
    ],
    [
        ['DELETE /api/v1/organizations/:organization'],
        'OrganizationController@destroy',
        'site',
        (_r, m) => `Menghapus site ${name(m, 'name')}`,
    ],
    [
        ['PUT /api/v1/settings/security'],
        'SecuritySettingController@update',
        'pengaturan',
        (r) =>
            boolean(r.two_factor_required)
                ? 'Menyalakan 2FA wajib untuk semua akun'
                : 'Mematikan 2FA wajib untuk semua akun',
    ],
]

export const ACTIONS: Record<string, Action> = Object.fromEntries(
    ACTION_LIST.flatMap(([keys, action, category, describe]) =>
        keys.map((key) => [key, { action, category, describe }])
    )
)

/**
 * Route publik yang memakai throttle di backend-api. 429 dari middleware
 * throttle tidak dicatat (di Laravel throttle berjalan sebelum
 * RecordApiActivity); 429 dari controller (mis. kunci per akun) tetap dicatat.
 */
const THROTTLED_ACTIONS = new Set([
    'AuthController@login',
    'AuthController@verifyTwoFactor',
    'AuthController@confirmTwoFactorSetup',
    'DeviceOtpController@verify',
    'DeviceEnrollmentController@claim',
])

/** Route tanpa auth:sanctum di backend-api; sisanya wajib login. */
const PUBLIC_ACTIONS = new Set([
    'AuthController@login',
    'AuthController@verifyTwoFactor',
    'AuthController@confirmTwoFactorSetup',
    'DeviceOtpController@verify',
    'DeviceEnrollmentController@claim',
])

/** Parameter route -> model, untuk objek yang dihapus (namanya diambil sebelum dihapus). */
export const ROUTE_MODELS: Record<string, ModelName> = {
    user: 'User',
    device: 'Device',
    geofence_rule: 'GeofenceRule',
    consentDocument: 'ConsentDocument',
    apk_build: 'ApkBuild',
    telegram_binding: 'TelegramBinding',
    telegram_user_link: 'TelegramUserLink',
    organization: 'Organization',
}

/** Objek baru (dibuat oleh aksi ini) per controller, diambil dari data.id respons. */
const CREATED_MODELS: Record<string, ModelName> = {
    UserController: 'User',
    DeviceController: 'Device',
    GeofenceRuleController: 'GeofenceRule',
    ConsentDocumentController: 'ConsentDocument',
    ApkBuildController: 'ApkBuild',
    OrganizationController: 'Organization',
    TelegramBindingController: 'TelegramBinding',
}

/** Input yang aman disimpan sebagai rincian (tidak pernah password, token, kode, atau berkas). */
export const SAFE_INPUT = [
    'username',
    'name',
    'email',
    'role',
    'organization_id',
    'device_name',
    'command_type',
    'issued_via',
    'reason_note',
    'rule_name',
    'allowed_ssid',
    'allowed_ip_cidr',
    'max_distance_meters',
    'subject_name',
    'signer_name',
    'signer_role',
    'apk_type',
    'version',
    'telegram_chat_id',
    'telegram_user_id',
    'telegram_username',
    'two_factor_required',
    'is_active',
    'organization_ids',
    'client',
]

/** Field yang tidak dirapikan TrimStrings Laravel. */
const UNTRIMMED = new Set(['current_password', 'password', 'password_confirmation'])

/** TrimStrings + ConvertEmptyStringsToNull Laravel (rekursif untuk array). */
export function normalizeInput(value: unknown, key = ''): unknown {
    if (typeof value === 'string') {
        const trimmed = UNTRIMMED.has(key)
            ? value
            : value.replace(
                  /^[ \t\n\v\f\r\uFEFF\u200B\u200E]+|[ \t\n\v\f\r\uFEFF\u200B\u200E]+$/g,
                  ''
              )
        return trimmed === '' ? null : trimmed
    }
    if (Array.isArray(value)) return value.map((item) => normalizeInput(item))
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([k, item]) => [k, normalizeInput(item, k)])
        )
    }
    return value
}

/** array_filter($request->only(SAFE_INPUT), fn ($v) => $v !== null && $v !== ''). */
export function safeInput(input: RequestInput): Record<string, unknown> | [] {
    const picked = Object.fromEntries(
        SAFE_INPUT.filter(
            (key) =>
                key in input && input[key] !== null && input[key] !== undefined && input[key] !== ''
        ).map((key) => [key, input[key]])
    )
    // Array PHP kosong di-JSON-kan sebagai [] (bukan {}).
    return Object.keys(picked).length ? picked : []
}

export function resultOf(status: number): 'ok' | 'denied' | 'failed' {
    if (status < 300) return 'ok'
    if (status < 500) return 'denied'
    return 'failed'
}

export async function findModel(model: ModelName, id: unknown, withTrashed = false) {
    const value = String(id ?? '')
    if (!/^\d{1,18}$/.test(value)) return null
    const { table, softDeletes } = MODEL_TABLES[model]
    const query = db.from(table).where('id', Number(value))
    if (softDeletes && !withTrashed) query.whereNull('deleted_at')
    return ((await query.first()) as ModelRow | null) ?? null
}

export default class RecordApiActivityMiddleware {
    async handle(ctx: HttpContext, next: NextFn) {
        const method = ctx.request.method()
        const definition =
            method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
                ? null
                : (ACTIONS[`${method} ${ctx.route?.pattern ?? ''}`] ?? null)

        if (!definition) {
            return next()
        }

        // Objek diambil SEBELUM aksi: setelah dihapus namanya sudah tidak ada.
        // Salinan keadaan sebelum aksi juga dipakai kalimat log ("Mengubah
        // device HP Kasir", bukan nama barunya).
        let subject: Subject | null = null
        for (const [key, value] of Object.entries(ctx.params ?? {})) {
            const model = ROUTE_MODELS[key]
            if (!model) continue
            const row = await findModel(model, value)
            if (!row) {
                // Route model binding Laravel menjawab 404 sebelum middleware ini.
                return next()
            }
            subject = { model, row }
            break
        }

        startBatch(ctx)
        try {
            const output = await next()
            await this.record(ctx, definition, subject)
            return output
        } finally {
            endBatch(ctx)
        }
    }

    private async record(ctx: HttpContext, definition: Action, before: Subject | null) {
        try {
            const status = ctx.response.getStatus()
            if (this.rejectedEarlier(ctx, definition, status)) return

            const body = ctx.response.getBody() as Record<string, unknown> | null
            const json = body && typeof body === 'object' && !Buffer.isBuffer(body) ? body : null
            const data =
                json?.data && typeof json.data === 'object'
                    ? (json.data as Record<string, unknown>)
                    : null
            const input = normalizeInput(ctx.request.all()) as RequestInput

            let subject: Subject | null = before
            if (subject) {
                // performedOn($subject): model yang sama setelah aksi (mis. site barunya).
                const after = await findModel(subject.model, subject.row.id, true)
                if (after) subject = { model: subject.model, row: after }
            } else {
                subject = await this.createdSubject(definition.action, data)
            }

            let causer: ModelRow | null = ctx.authUser
                ? { id: ctx.authUser.id, organization_id: ctx.authUser.organizationId }
                : null
            if (!causer && definition.action.startsWith('AuthController@')) {
                // Login berhasil: pelakunya pemilik akun. Login gagal: yang
                // mencoba belum tentu pemiliknya -- akun itu dicatat sebagai
                // objek (sasaran), bukan pelaku.
                const account = await this.accountFromAuthRequest(input, data)
                if (status < 300) {
                    causer = account
                } else if (!subject && account) {
                    subject = { model: 'User', row: account }
                }
            }

            const describedSubject = before?.row ?? subject?.row ?? null
            const description = definition.describe(input, describedSubject, status, data)
            const safe = safeInput(input)

            await writeActivity(ctx, {
                logName: LOG_NAME,
                description,
                event: definition.action,
                subjectType: subject ? MODEL_MORPHS[subject.model] : null,
                subjectId: subject ? Number(subject.row.id) : null,
                causerId: causer ? Number(causer.id) : null,
                properties: {
                    category: definition.category,
                    status,
                    result: resultOf(status),
                    message: status >= 300 ? strimwidth(phpString(json?.message ?? ''), 200) : null,
                    input: safe,
                    route: `${ctx.request.method()} ${ctx.request.url()}`,
                },
                organizationId: activityOrganizationId(subject, safe, causer),
            })
        } catch (error) {
            // Mencatat log tidak boleh menggagalkan aksi utamanya.
            logger.error({ err: error }, 'Log aktivitas API gagal dicatat')
        }
    }

    /**
     * Ditolak middleware yang di Laravel berjalan SEBELUM RecordApiActivity:
     * auth:sanctum (user tidak terisi) dan throttle (429 tanpa header
     * X-RateLimit-Limit, yang hanya dipasang throttle saat lolos).
     */
    private rejectedEarlier(ctx: HttpContext, definition: Action, status: number): boolean {
        if (!PUBLIC_ACTIONS.has(definition.action) && !ctx.authUser) return true
        return (
            status === 429 &&
            THROTTLED_ACTIONS.has(definition.action) &&
            !ctx.response.getHeader('X-RateLimit-Limit')
        )
    }

    private async createdSubject(
        action: string,
        data: Record<string, unknown> | null
    ): Promise<Subject | null> {
        const model = CREATED_MODELS[action.split('@')[0]]
        const id = data?.id
        if (!model || !isNumeric(id)) return null
        const row = await findModel(model, id)
        return row ? { model, row } : null
    }

    /** Login & 2FA belum membawa token: akun dicari dari respons atau username yang dikirim. */
    private async accountFromAuthRequest(
        input: RequestInput,
        data: Record<string, unknown> | null
    ): Promise<ModelRow | null> {
        const user = data?.user as { id?: unknown } | undefined
        if (user && user.id !== undefined && user.id !== null) {
            return findModel('User', user.id)
        }
        const identifier = phpString(input.username).trim().toLowerCase()
        if (identifier === '') return null

        return (
            ((await db
                .from('users')
                .whereNull('deleted_at')
                .where((query) => {
                    query
                        .whereRaw('LOWER(username) = ?', [identifier])
                        .orWhereRaw('LOWER(email) = ?', [identifier])
                })
                .first()) as ModelRow | null) ?? null
        )
    }
}

function isNumeric(value: unknown): boolean {
    if (typeof value === 'number') return Number.isFinite(value)
    return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
}

/**
 * organization_id catatan (AppServiceProvider backend-api): site itu sendiri,
 * site milik objek, organization_id di input, atau site pelakunya.
 */
export function activityOrganizationId(
    subject: { model: string; row: ModelRow } | null,
    input: Record<string, unknown> | [],
    causer: ModelRow | null
): number | null {
    if (subject?.model === 'Organization') return Number(subject.row.id)
    const subjectOrganization = subject?.row.organization_id
    if (subjectOrganization !== null && subjectOrganization !== undefined) {
        return Number(subjectOrganization)
    }
    const requested = Array.isArray(input) ? undefined : input.organization_id
    if (isNumeric(requested)) return Math.trunc(Number(requested))
    const causerOrganization = causer?.organization_id
    return causerOrganization === null || causerOrganization === undefined
        ? null
        : Number(causerOrganization)
}
