import { randomUUID } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'

/**
 * Menulis tabel activity_log dengan format spatie/laravel-activitylog yang
 * dipakai backend-api, supaya menu Log aktivitas tetap membaca satu sumber.
 *
 * Model yang memakai LogsActivity di backend-api: User, Organization, Device,
 * GeofenceRule, ConsentDocument, AppSetting, WorkSession -- tiap modul
 * memanggil logModelEvent() dengan atribut yang sama seperti
 * getActivitylogOptions() model itu.
 */

/** Tanggal seperti serializeDate() Eloquent: 2026-10-25T03:45:45.000000Z. */
export function laravelDate(value: Date | null): string | null {
    return value ? value.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z') : null
}

type ModelLog = {
    event: 'created' | 'updated' | 'deleted'
    /** Morph Laravel, mis. 'App\Models\Device' (lihat konstanta *_MORPH). */
    subjectType: string
    subjectId: number
    organizationId: number | null
    attributes: Record<string, unknown>
    old?: Record<string, unknown>
}

/**
 * Satu baris activity_log apa adanya. Dipakai logModelEvent() (perubahan data
 * model) dan middleware log request API (catatan "siapa melakukan apa").
 */
export type ActivityRow = {
    logName: string
    description: string
    event: string | null
    subjectType: string | null
    subjectId: number | null
    /** null = tanpa pelaku; undefined = user yang sedang login. */
    causerId?: number | null
    properties: Record<string, unknown>
    organizationId: number | null
}

// LogBatch Laravel: perubahan data dalam satu request API yang dicatat
// digabung lewat batch_uuid yang sama dengan baris ringkasan request-nya.
const batches = new WeakMap<HttpContext, string>()

export function startBatch(ctx: HttpContext): string {
    const uuid = randomUUID()
    batches.set(ctx, uuid)
    return uuid
}

export function endBatch(ctx: HttpContext) {
    batches.delete(ctx)
}

export async function writeActivity(ctx: HttpContext | null, row: ActivityRow) {
    const now = new Date()
    const causerId = row.causerId === undefined ? (ctx?.authUser?.id ?? null) : row.causerId

    await db.table('activity_log').insert({
        log_name: row.logName,
        description: row.description,
        event: row.event,
        subject_type: row.subjectType,
        subject_id: row.subjectId,
        causer_type: causerId === null ? null : LARAVEL_USER_MORPH,
        causer_id: causerId,
        properties: JSON.stringify(row.properties),
        batch_uuid: ctx ? (batches.get(ctx) ?? null) : null,
        organization_id: row.organizationId,
        ip_address: ctx?.request.ip() ?? null,
        user_agent: ctx?.request.header('user-agent')?.slice(0, 255) || null,
        created_at: now,
        updated_at: now,
    })
}

/** Perubahan data model (trait LogsActivity): log_name 'default', logOnlyDirty. */
export async function logModelEvent(ctx: HttpContext | null, entry: ModelLog) {
    await writeActivity(ctx, {
        logName: 'default',
        description: entry.event,
        event: entry.event,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        properties: entry.old
            ? { attributes: entry.attributes, old: entry.old }
            : { attributes: entry.attributes },
        organizationId: entry.organizationId,
    })
}

export const WORK_SESSION_MORPH = 'App\\Models\\WorkSession'
