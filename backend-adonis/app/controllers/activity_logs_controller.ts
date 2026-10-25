import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { accessOf, can } from '#services/access'
import { WORK_SESSION_MORPH } from '#services/activity_log'
import { fail, success } from '#services/api_response'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'
import { authorizedOrganizationId, hasCrossOrganizationAccess } from '#services/organization_scope'
import {
    LOG_NAME,
    MODEL_MORPHS,
    MODEL_TABLES,
    type ModelName,
    type ModelRow,
} from '#middleware/record_api_activity_middleware'

/**
 * Menu Log aktivitas -- padanan ActivityLogController di backend-api: siapa
 * melakukan apa di sistem (lihat record_api_activity_middleware), bukan log
 * jam kerja. Super admin melihat semua site, Admin Site hanya site-nya
 * sendiri (permission activity-logs.view).
 */

const PAGE_SIZE = 50

/** Kunci yang tidak pernah ditampilkan isinya di rincian perubahan. */
const HIDDEN_FIELDS = /password|secret|token|recovery|two_factor_secret/i

const SUBJECT_LABELS: Record<string, string> = {
    User: 'Staf',
    Device: 'Device',
    GeofenceRule: 'Aturan geofence',
    ConsentDocument: 'Dokumen consent',
    Organization: 'Site',
    ApkBuild: 'Build APK',
    TelegramBinding: 'Grup Telegram',
    TelegramUserLink: 'Tautan Telegram',
    AppSetting: 'Pengaturan',
}

const NAME_ATTRIBUTES = [
    'username',
    'device_name',
    'rule_name',
    'subject_name',
    'name',
    'version',
    'telegram_chat_id',
    'key',
]

export type ActivityRow = {
    id: number
    log_name: string | null
    description: string
    subject_type: string | null
    subject_id: number | null
    event: string | null
    causer_type: string | null
    causer_id: number | null
    properties: Record<string, unknown> | unknown[] | null
    batch_uuid: string | null
    organization_id: number | null
    ip_address: string | null
    user_agent: string | null
    created_at: Date | null
    /** Relasi subject (morphTo), null kalau tidak ada / sudah terhapus. */
    subject?: ModelRow | null
    /** Relasi causer (User), null kalau akunnya terhapus. */
    causer?: { id: number; name: string; username: string } | null
}

type Filters = {
    organizationId: number | null
    from: string | null
    to: string | null
    category: string | null
    result: string | null
    search: string | null
    beforeId: number | null
}

export default class ActivityLogsController {
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'activity-logs.view')) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melakukan tindakan ini'))
        }

        const validated = validate(ctx.request.qs())
        if ('errors' in validated) {
            return ctx.response
                .status(422)
                .send(fail('Isian tidak lolos validasi', validated.errors))
        }
        const filters = validated.filters

        // Super admin: semua site (atau satu site pilihan). Lainnya: site sendiri saja.
        let organizationId: number | null
        if (hasCrossOrganizationAccess(access)) {
            organizationId = filters.organizationId
        } else {
            organizationId = authorizedOrganizationId(access, filters.organizationId)
            if (organizationId === null) {
                return ctx.response
                    .status(403)
                    .send(fail('Anda tidak berwenang melihat log site ini'))
            }
        }

        const entries = await queryEntries({ ...filters, organizationId })
        await loadRelations(entries)
        const changes = await batchChanges(entries)
        const siteNames = await organizationNames(entries)

        return success('Log aktivitas', {
            entries: entries.map((entry) => payload(entry, changes, siteNames)),
            has_more: entries.length === PAGE_SIZE,
        })
    }
}

async function queryEntries(filters: Filters): Promise<ActivityRow[]> {
    const query = db
        .from('activity_log')
        // Aksi API + perubahan data di luar permintaan API (mis. perintah
        // server). Perubahan di dalam permintaan tampil sebagai rincian
        // aksinya; sesi kerja punya log sendiri (Aktivitas user).
        .where((outer) => {
            outer.where('log_name', LOG_NAME).orWhere((inner) => {
                inner.whereNull('batch_uuid').where((type) => {
                    type.whereNull('subject_type').orWhere('subject_type', '!=', WORK_SESSION_MORPH)
                })
            })
        })

    if (filters.organizationId !== null) {
        query.where('organization_id', filters.organizationId)
    }
    if (filters.from) {
        query.where('created_at', '>=', filters.from)
    }
    if (filters.to) {
        query.where('created_at', '<=', filters.to)
    }
    if (filters.category) {
        if (filters.category === 'data') {
            query.where('log_name', '!=', LOG_NAME)
        } else {
            query.whereRaw(`("properties"->>'category') = ?`, [filters.category])
        }
    }
    if (filters.result) {
        query.whereRaw(`("properties"->>'result') = ?`, [filters.result])
    }
    if (filters.search) {
        const like = searchPattern(filters.search)
        // User::withTrashed(): pelaku yang akunnya sudah dihapus tetap bisa dicari.
        const causers = await db
            .from('users')
            .whereRaw('LOWER(name) LIKE ?', [like])
            .orWhereRaw('LOWER(username) LIKE ?', [like])
            .select('id')
        const causerIds = causers.map((row) => row.id)
        query.where((search) => {
            search
                .whereRaw('LOWER(description) LIKE ?', [like])
                .orWhere((causer) => {
                    causer.where('causer_type', LARAVEL_USER_MORPH).whereIn('causer_id', causerIds)
                })
                .orWhere('ip_address', 'like', like)
        })
    }
    if (filters.beforeId) {
        query.where('id', '<', filters.beforeId)
    }

    return query.orderBy('id', 'desc').limit(PAGE_SIZE)
}

/** '%'.str_replace(['%', '_'], ['\%', '\_'], mb_strtolower($search)).'%' */
export function searchPattern(search: string): string {
    return `%${search.toLowerCase().replace(/[%_]/g, (char) => `\\${char}`)}%`
}

/** with(['causer', 'subject']) -- morphTo; baris soft-deleted tidak ikut dimuat. */
async function loadRelations(entries: ActivityRow[]) {
    const subjects = await loadSubjects(entries)
    for (const entry of entries) {
        entry.subject = subjects.get(`${entry.subject_type}#${entry.subject_id}`) ?? null
    }

    const causerIds = [
        ...new Set(
            entries
                .filter((entry) => entry.causer_type === LARAVEL_USER_MORPH && entry.causer_id)
                .map((entry) => entry.causer_id!)
        ),
    ]
    const causers = causerIds.length
        ? await db
              .from('users')
              .whereIn('id', causerIds)
              .whereNull('deleted_at')
              .select('id', 'name', 'username')
        : []
    const byId = new Map(causers.map((causer) => [Number(causer.id), causer]))
    for (const entry of entries) {
        entry.causer =
            entry.causer_type === LARAVEL_USER_MORPH && entry.causer_id
                ? (byId.get(Number(entry.causer_id)) ?? null)
                : null
    }
}

async function loadSubjects(entries: ActivityRow[]): Promise<Map<string, ModelRow>> {
    const byType = new Map<string, Set<number>>()
    for (const entry of entries) {
        if (!entry.subject_type || !entry.subject_id) continue
        if (!byType.has(entry.subject_type)) byType.set(entry.subject_type, new Set())
        byType.get(entry.subject_type)!.add(Number(entry.subject_id))
    }

    const loaded = new Map<string, ModelRow>()
    for (const [type, ids] of byType) {
        const model = (Object.keys(MODEL_MORPHS) as ModelName[]).find(
            (key) => MODEL_MORPHS[key] === type
        )
        if (!model) continue
        const { table, softDeletes } = MODEL_TABLES[model]
        const query = db.from(table).whereIn('id', [...ids])
        if (softDeletes) query.whereNull('deleted_at')
        for (const row of (await query) as ModelRow[]) {
            loaded.set(`${type}#${row.id}`, row)
        }
    }
    return loaded
}

/**
 * Perubahan data (sebelum -> sesudah) yang terjadi dalam permintaan
 * yang sama dengan tiap aksi, dikelompokkan per batch_uuid.
 */
async function batchChanges(entries: ActivityRow[]): Promise<Map<string, ActivityRow[]>> {
    const batches = [
        ...new Set(
            entries
                .filter((entry) => entry.log_name === LOG_NAME && entry.batch_uuid)
                .map((entry) => entry.batch_uuid!)
        ),
    ]
    const grouped = new Map<string, ActivityRow[]>()
    if (!batches.length) return grouped

    const rows: ActivityRow[] = await db
        .from('activity_log')
        .whereIn('batch_uuid', batches)
        .where('log_name', '!=', LOG_NAME)
        .orderBy('id')
    const subjects = await loadSubjects(rows)
    for (const row of rows) {
        row.subject = subjects.get(`${row.subject_type}#${row.subject_id}`) ?? null
        if (!grouped.has(row.batch_uuid!)) grouped.set(row.batch_uuid!, [])
        grouped.get(row.batch_uuid!)!.push(row)
    }
    return grouped
}

/** Organization::withTrashed()->pluck('name', 'id'). */
async function organizationNames(entries: ActivityRow[]): Promise<Map<number, string>> {
    const ids = [
        ...new Set(entries.map((entry) => entry.organization_id).filter((id) => id)),
    ] as number[]
    if (!ids.length) return new Map()
    const rows = await db.from('organizations').whereIn('id', ids).select('id', 'name')
    return new Map(rows.map((row) => [Number(row.id), row.name]))
}

function propertiesOf(activity: ActivityRow): Record<string, unknown> {
    const properties = activity.properties
    return properties && typeof properties === 'object' && !Array.isArray(properties)
        ? properties
        : {}
}

export function payload(
    activity: ActivityRow,
    changes: Map<string, ActivityRow[]>,
    siteNames: Map<number, string>
) {
    const properties = propertiesOf(activity)
    const isApi = activity.log_name === LOG_NAME
    const causer = activity.causer ?? null
    const related = isApi
        ? activity.batch_uuid
            ? (changes.get(activity.batch_uuid) ?? [])
            : []
        : [activity]

    return {
        id: activity.id,
        at: activity.created_at ? iso8601(activity.created_at) : null,
        category: isApi ? (properties.category ?? 'lainnya') : 'data',
        description: isApi ? activity.description : dataChangeSentence(activity),
        result: properties.result ?? 'ok',
        status: properties.status ?? null,
        message: properties.message ?? null,
        causer: causer
            ? { id: causer.id, name: causer.name, username: causer.username }
            : activity.causer_id
              ? { id: activity.causer_id, name: 'Akun terhapus', username: null }
              : null,
        subject: activity.subject_type
            ? {
                  type: subjectLabel(activity.subject_type) ?? classBasename(activity.subject_type),
                  name: subjectName(activity),
              }
            : null,
        organization: activity.organization_id
            ? {
                  id: activity.organization_id,
                  name: siteNames.get(Number(activity.organization_id)) ?? null,
              }
            : null,
        ip_address: activity.ip_address,
        device: deviceLabel(activity.user_agent),
        user_agent: activity.user_agent,
        route: properties.route ?? null,
        input: safeValues(properties.input ?? []),
        changes: related
            .map((change) => ({
                type:
                    subjectLabel(change.subject_type ?? '') ??
                    classBasename(change.subject_type ?? ''),
                name: subjectName(change),
                event: change.event,
                fields: fieldChanges(change),
            }))
            .filter((change) => change.fields.length || change.event !== 'updated'),
    }
}

function classBasename(type: string): string {
    return type.split('\\').pop() ?? type
}

function subjectLabel(type: string): string | undefined {
    return SUBJECT_LABELS[classBasename(type)]
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export function fieldChanges(activity: ActivityRow) {
    const properties = propertiesOf(activity)
    const updated = asRecord(properties.attributes)
    const old = asRecord(properties.old)
    const fields: Array<{ field: string; old: unknown; new: unknown }> = []
    for (const field of new Set([...Object.keys(updated), ...Object.keys(old)])) {
        const hidden = HIDDEN_FIELDS.test(field)
        fields.push({
            field,
            old: hidden ? '••••' : (old[field] ?? null),
            new: hidden ? '••••' : (updated[field] ?? null),
        })
    }
    return fields
}

/** filled() Laravel. */
function filled(value: unknown): boolean {
    if (value === null || value === undefined) return false
    if (typeof value === 'string') return value.trim() !== ''
    if (Array.isArray(value)) return value.length > 0
    return true
}

const isScalar = (value: unknown) =>
    ['string', 'number', 'boolean', 'bigint'].includes(typeof value)

export function subjectName(activity: ActivityRow): string | null {
    const properties = propertiesOf(activity)
    const values = { ...asRecord(properties.old), ...asRecord(properties.attributes) }
    for (const attribute of NAME_ATTRIBUTES) {
        const value = activity.subject?.[attribute] ?? values[attribute] ?? null
        if (filled(value) && isScalar(value)) {
            return value === true ? '1' : value === false ? '' : String(value)
        }
    }
    return activity.subject_id ? `#${activity.subject_id}` : null
}

export function dataChangeSentence(activity: ActivityRow): string {
    const verbs: Record<string, string> = {
        created: 'dibuat',
        updated: 'diubah',
        deleted: 'dihapus',
    }
    const verb = activity.event ? verbs[activity.event] : undefined
    if (!verb) {
        return activity.description
    }
    const type = subjectLabel(activity.subject_type ?? '') ?? 'Data'

    return `${type} ${subjectName(activity) ?? ''} ${verb}`.trim()
}

/** Input yang aman ditampilkan; array PHP kosong tetap [] di JSON. */
export function safeValues(values: unknown): Record<string, unknown> | unknown[] {
    if (Array.isArray(values)) return values
    const kept = Object.fromEntries(
        Object.entries(asRecord(values)).filter(([key]) => !HIDDEN_FIELDS.test(key))
    )
    return Object.keys(kept).length ? kept : []
}

/** "Chrome · Windows", "Aplikasi Android", ... -- cukup untuk mengenali dari mana aksi dilakukan. */
export function deviceLabel(userAgent: string | null): string | null {
    if (!userAgent) {
        return null
    }
    if (/okhttp|Dalvik|Ktor/i.test(userAgent)) {
        return 'Aplikasi Android'
    }
    if (/axios|node|python|curl|Symfony/i.test(userAgent)) {
        return 'Server / bot'
    }

    let browser = 'Browser'
    if (userAgent.includes('Edg/')) browser = 'Edge'
    else if (userAgent.includes('OPR/')) browser = 'Opera'
    else if (userAgent.includes('Firefox/')) browser = 'Firefox'
    else if (userAgent.includes('Chrome/')) browser = 'Chrome'
    else if (userAgent.includes('Safari/')) browser = 'Safari'

    let os: string | null = null
    if (userAgent.includes('Android')) os = 'Android'
    else if (/iPhone|iPad/.test(userAgent)) os = 'iOS'
    else if (userAgent.includes('Windows')) os = 'Windows'
    else if (userAgent.includes('Mac OS')) os = 'macOS'
    else if (userAgent.includes('Linux')) os = 'Linux'

    return os ? `${browser} · ${os}` : browser
}

/** Carbon toIso8601String() (app.timezone UTC): 2026-10-25T03:45:45+00:00. */
function iso8601(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

/* ---------------------------------------------------------------------
 | Validasi -- pesan sama dengan validator Laravel (locale en).
 * ------------------------------------------------------------------- */

type ValidationErrors = Record<string, string[]>

/** Middleware TrimStrings + ConvertEmptyStringsToNull Laravel. */
function normalized(value: unknown): unknown {
    if (typeof value !== 'string') return value ?? null
    const trimmed = value.replace(
        /^[ \t\n\v\f\r\uFEFF\u200B\u200E]+|[ \t\n\v\f\r\uFEFF\u200B\u200E]+$/g,
        ''
    )
    return trimmed === '' ? null : trimmed
}

/** Nilai yang dianggap "kosong" oleh ->when() PHP: null, '', '0'. */
const phpFalsy = (value: unknown) => value === null || value === '' || value === '0'

export function validate(
    query: Record<string, unknown>
): { filters: Filters } | { errors: ValidationErrors } {
    const errors: ValidationErrors = {}
    const value = (key: string) => normalized(query[key])

    const integer = (key: string): number | null => {
        const raw = value(key)
        if (raw === null) return null
        if (typeof raw === 'string' && /^[+-]?(0|[1-9]\d{0,17})$/.test(raw)) return Number(raw)
        errors[key] = [`The ${key.replace(/_/g, ' ')} field must be an integer.`]
        return null
    }
    const date = (key: string): string | null => {
        const raw = value(key)
        if (raw === null) return null
        const parsed = typeof raw === 'string' ? carbonBinding(raw) : null
        if (parsed === null) {
            errors[key] = [`The ${key} field must be a valid date.`]
        }
        return parsed
    }
    const string = (key: string, max: number): string | null => {
        const raw = value(key)
        if (raw === null) return null
        if (typeof raw !== 'string') {
            errors[key] = [`The ${key} field must be a string.`]
            return null
        }
        if ([...raw].length > max) {
            errors[key] = [`The ${key} field must not be greater than ${max} characters.`]
            return null
        }
        return raw
    }

    const organizationId = integer('organization_id')
    const from = date('from')
    const to = date('to')
    const category = string('category', 30)
    const resultRaw = value('result')
    let result: string | null = null
    if (resultRaw !== null) {
        if (typeof resultRaw === 'string' && ['ok', 'denied', 'failed'].includes(resultRaw)) {
            result = resultRaw
        } else {
            errors.result = ['The selected result is invalid.']
        }
    }
    const search = string('search', 100)
    const beforeId = integer('before_id')

    if (Object.keys(errors).length) return { errors }

    return {
        filters: {
            organizationId,
            from,
            to,
            category: phpFalsy(category) ? null : category,
            result,
            search: phpFalsy(search) ? null : search,
            beforeId: beforeId || null,
        },
    }
}

/**
 * Carbon::parse($value) sebagai binding query Laravel: jam "Y-m-d H:i:s"
 * DALAM zona yang ditulis di input (offset tidak dikonversi ke UTC), atau UTC
 * kalau input tanpa zona. null = bukan tanggal yang valid.
 */
export function carbonBinding(value: string): string | null {
    const options = { setZone: true, zone: 'UTC' }
    let parsed = DateTime.fromISO(value, options)
    if (!parsed.isValid) parsed = DateTime.fromSQL(value, options)
    if (!parsed.isValid) parsed = DateTime.fromRFC2822(value, options)
    if (!parsed.isValid) return null
    return parsed.toFormat('yyyy-MM-dd HH:mm:ss')
}
