import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { laravelDate, logModelEvent, writeActivity } from '#services/activity_log'

/**
 * Bentuk data & helper modul device -- padanan DeviceResource,
 * DeviceCommandResource, DeviceLocationResource, ViolationLogResource, dan
 * perilaku model Device (SoftDeletes, LogsActivity) di backend-api.
 */

/** Morph Laravel untuk activity_log.subject_type. */
export const DEVICE_MORPH = 'App\\Models\\Device'

export type DeviceRow = {
    id: number
    organization_id: number
    consent_document_id: number | null
    device_name: string
    device_uuid: string
    android_version: string
    app_build_version: string
    site_code_embedded: string
    status: string
    battery_level: number | null
    last_seen_at: Date | null
    enrolled_at: Date | null
    is_active: boolean
    secret_hash?: string | null
    created_by: number | null
    updated_by: number | null
    created_at: Date | null
    updated_at: Date | null
    deleted_at?: Date | null
}

export type DeviceLocationRow = {
    id: number
    device_id: number
    source: string
    latitude: string | number | null
    longitude: string | number | null
    ble_distance_meters: string | number | null
    ble_rssi: number | null
    recorded_at: Date | null
}

/**
 * Relasi yang "dimuat" (whenLoaded di Laravel). undefined = tidak dimuat,
 * jadi kuncinya tidak muncul sama sekali di JSON -- sama seperti Laravel.
 */
type DeviceRelations = {
    organizationName?: string | null
    latestLocation?: DeviceLocationRow | null
}

export function deviceResource(device: DeviceRow, relations: DeviceRelations = {}) {
    return {
        id: device.id,
        organization_id: device.organization_id,
        ...(relations.organizationName !== undefined
            ? { organization_name: relations.organizationName }
            : {}),
        consent_document_id: device.consent_document_id,
        device_name: device.device_name,
        device_uuid: device.device_uuid,
        android_version: device.android_version,
        app_build_version: device.app_build_version,
        status: device.status,
        battery_level: device.battery_level ?? null,
        last_seen_at: laravelDate(device.last_seen_at ?? null),
        enrolled_at: laravelDate(device.enrolled_at ?? null),
        is_active: Boolean(device.is_active),
        ...(relations.latestLocation !== undefined
            ? {
                  latest_location: relations.latestLocation
                      ? deviceLocationResource(relations.latestLocation)
                      : null,
              }
            : {}),
        created_at: laravelDate(device.created_at ?? null),
        updated_at: laravelDate(device.updated_at ?? null),
    }
}

/**
 * Cast decimal:N Eloquent mengeluarkan string dengan N angka di belakang koma.
 * Kolom numeric(…, N) Postgres sudah dikirim pg dalam bentuk itu; nilai lain
 * (mis. angka JS) dibulatkan ke N digit supaya bentuknya tetap sama.
 */
export function laravelDecimal(value: string | number | null, scale: number): string | null {
    if (value === null || value === undefined) return null
    if (typeof value === 'string' && new RegExp(`^-?\\d+\\.\\d{${scale}}$`).test(value)) {
        return value
    }
    const number = Number(value)
    return Number.isFinite(number) ? number.toFixed(scale) : String(value)
}

export function deviceLocationResource(location: DeviceLocationRow) {
    return {
        id: location.id,
        device_id: location.device_id,
        source: location.source,
        latitude: laravelDecimal(location.latitude, 7),
        longitude: laravelDecimal(location.longitude, 7),
        ble_distance_meters: laravelDecimal(location.ble_distance_meters, 2),
        ble_rssi: location.ble_rssi ?? null,
        recorded_at: laravelDate(location.recorded_at ?? null),
    }
}

export function deviceCommandResource(command: Record<string, any>) {
    return {
        id: command.id,
        device_id: command.device_id,
        command_type: command.command_type,
        issued_by: command.issued_by,
        issued_via: command.issued_via,
        status: command.status,
        reason_note: command.reason_note ?? null,
        acknowledged_at: laravelDate(command.acknowledged_at ?? null),
        created_at: laravelDate(command.created_at ?? null),
    }
}

export function violationLogResource(log: Record<string, any>) {
    return {
        id: log.id,
        device_id: log.device_id,
        geofence_rule_id: log.geofence_rule_id ?? null,
        violation_type: log.violation_type,
        detected_value: log.detected_value,
        notified_telegram: Boolean(log.notified_telegram),
        notified_dashboard: Boolean(log.notified_dashboard),
        detected_at: laravelDate(log.detected_at ?? null),
    }
}

/**
 * now() seperti yang disimpan Eloquent: kolom timestamp(0) diisi lewat
 * format 'Y-m-d H:i:s', jadi nilai di model (dan di JSON) tanpa pecahan detik.
 */
export function eloquentNow(): Date {
    return new Date(Math.floor(Date.now() / 1000) * 1000)
}

/** intval() PHP: "12abc" -> 12, "abc" -> 0, "1e2" -> 100, "2.9" -> 2. */
export function phpIntval(value: unknown): number {
    if (value === null || value === undefined) return 0
    if (typeof value === 'boolean') return value ? 1 : 0
    if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0
    if (Array.isArray(value)) return value.length ? 1 : 0
    if (typeof value !== 'string') return 1

    const match = /^[ \t\n\r\v\f]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(value)
    if (!match) return 0
    const number = Math.trunc(Number(match[1]))
    return Number.isFinite(number) ? number : 0
}

/**
 * Ukuran halaman seperti $query->paginate($request->integer('per_page', 20)):
 * per_page tidak dikirim = 20; 0/tidak valid = 15 (perPage default model);
 * negatif = tanpa batas (Builder::limit() Laravel mengabaikan nilai negatif).
 */
export function perPageOf(raw: unknown): number | null {
    const perPage = raw === undefined ? 20 : phpIntval(raw)
    if (perPage === 0) return 15
    return perPage < 0 ? null : perPage
}

/** Paginator::resolveCurrentPage(): bilangan bulat >= 1, selain itu halaman 1. */
export function pageOf(raw: unknown): number {
    const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
    if (!/^[+-]?(?:0|[1-9]\d*)$/.test(text)) return 1
    const page = Number.parseInt(text, 10)
    return page >= 1 && Number.isSafeInteger(page) ? page : 1
}

type QueryFactory = () => ReturnType<typeof db.from>

/** Padanan paginate() -> ['items', 'total'] yang dipakai semua endpoint daftar device. */
export async function paginate(ctx: HttpContext, query: QueryFactory) {
    const perPage = perPageOf(ctx.request.input('per_page'))
    const page = pageOf(ctx.request.input('page'))

    const [{ total }] = await query().clearOrder().clearSelect().count('* as total')
    const count = Number(total)
    if (count === 0) {
        return { rows: [] as Record<string, any>[], total: 0 }
    }

    const rows = query()
    if (perPage !== null) {
        rows.offset((page - 1) * perPage).limit(perPage)
    }
    return { rows: (await rows) as Record<string, any>[], total: count }
}

/** Device yang belum di-soft-delete (route model binding {device}); 404 kalau tidak ada. */
export async function findDeviceOrFail(id: string | number): Promise<DeviceRow> {
    const device = /^\d{1,18}$/.test(String(id))
        ? await db.from('devices').where('id', String(id)).whereNull('deleted_at').first()
        : null
    if (!device) {
        throw new Exception('Data tidak ditemukan', { status: 404, code: 'E_ROW_NOT_FOUND' })
    }
    return device as DeviceRow
}

/** Lokasi terakhir per device (eager load locations latest('recorded_at')->limit(1)). */
export async function latestLocationsOf(deviceIds: number[]) {
    const latest = new Map<number, DeviceLocationRow>()
    if (!deviceIds.length) return latest

    const rows = await db
        .from('device_locations')
        .distinctOn('device_id')
        .whereIn('device_id', deviceIds)
        .orderBy('device_id')
        .orderBy('recorded_at', 'desc')
        .select('*')
    for (const row of rows) latest.set(Number(row.device_id), row as DeviceLocationRow)
    return latest
}

// --- LogsActivity: logOnly(['device_name', 'status', 'is_active'])->logOnlyDirty()->dontSubmitEmptyLogs()

const LOGGED_ATTRIBUTES = ['device_name', 'status', 'is_active'] as const

type DeviceChanges = Partial<
    Pick<DeviceRow, 'device_name' | 'status' | 'is_active' | 'secret_hash' | 'updated_by'>
>

function loggedValues(device: Pick<DeviceRow, (typeof LOGGED_ATTRIBUTES)[number]>) {
    return {
        device_name: device.device_name,
        status: device.status,
        is_active: Boolean(device.is_active),
    }
}

/**
 * Kolom yang benar-benar berubah (isDirty Eloquent). Kalau tidak ada yang
 * berubah, Eloquent tidak menyimpan apa pun -- updated_at pun tetap.
 */
export function dirtyChanges(device: DeviceRow, changes: DeviceChanges): DeviceChanges {
    const dirty: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(changes)) {
        const original = (device as Record<string, unknown>)[key]
        const same = key === 'is_active' ? Boolean(original) === Boolean(value) : original === value
        if (!same && value !== undefined) dirty[key] = value
    }
    return dirty as DeviceChanges
}

/**
 * $device->update()/forceFill()->save(): simpan kolom yang berubah saja
 * (plus updated_at), lalu kembalikan device dengan nilai baru. Pencatatan
 * activity_log dilakukan pemanggil lewat logDeviceUpdated() -- sengaja
 * dipisah supaya bisa dipanggil setelah transaksi selesai.
 */
export async function updateDevice(
    device: DeviceRow,
    changes: DeviceChanges,
    trx?: TransactionClientContract
): Promise<DeviceRow> {
    const dirty = dirtyChanges(device, changes)
    if (!Object.keys(dirty).length) return device

    const updatedAt = eloquentNow()
    await (trx ?? db)
        .from('devices')
        .where('id', device.id)
        .update({ ...dirty, updated_at: updatedAt })
    return { ...device, ...dirty, updated_at: updatedAt }
}

export async function logDeviceCreated(ctx: HttpContext | null, device: DeviceRow) {
    await logModelEvent(ctx, {
        event: 'created',
        subjectType: DEVICE_MORPH,
        subjectId: device.id,
        organizationId: device.organization_id,
        attributes: loggedValues(device),
    })
}

/** Hanya atribut tercatat yang berubah; tidak ada = tidak ada baris log. */
export async function logDeviceUpdated(
    ctx: HttpContext | null,
    before: DeviceRow,
    after: DeviceRow
) {
    const oldValues = loggedValues(before)
    const newValues = loggedValues(after)
    const attributes: Record<string, unknown> = {}
    const old: Record<string, unknown> = {}
    for (const key of LOGGED_ATTRIBUTES) {
        if (oldValues[key] !== newValues[key]) {
            attributes[key] = newValues[key]
            old[key] = oldValues[key]
        }
    }
    if (!Object.keys(attributes).length) return

    await logModelEvent(ctx, {
        event: 'updated',
        subjectType: DEVICE_MORPH,
        subjectId: after.id,
        organizationId: after.organization_id,
        attributes,
        old,
    })
}

/** Event 'deleted' spatie: properties hanya berisi 'old' (tanpa 'attributes'). */
export async function logDeviceDeleted(ctx: HttpContext | null, device: DeviceRow) {
    await writeActivity(ctx, {
        logName: 'default',
        description: 'deleted',
        event: 'deleted',
        subjectType: DEVICE_MORPH,
        subjectId: device.id,
        properties: { old: loggedValues(device) },
        organizationId: device.organization_id,
    })
}

/** updateDevice() + logDeviceUpdated() untuk perubahan di luar transaksi. */
export async function saveDevice(
    ctx: HttpContext | null,
    device: DeviceRow,
    changes: DeviceChanges
) {
    const updated = await updateDevice(device, changes)
    await logDeviceUpdated(ctx, device, updated)
    return updated
}
