import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { accessOf, can } from '#services/access'
import { fail, success } from '#services/api_response'
import { laravelDate, logModelEvent, writeActivity } from '#services/activity_log'
import { authorizedOrganizationId, organizationFilter } from '#services/organization_scope'
import {
    paginationOf,
    requestedOrganizationId,
    storeGeofenceRuleValidator,
    updateGeofenceRuleValidator,
} from '#validators/rules'

/** subject_type activity_log untuk model GeofenceRule Laravel. */
export const GEOFENCE_RULE_MORPH = 'App\\Models\\GeofenceRule'

/** getActivitylogOptions()->logOnly() milik GeofenceRule. */
export const GEOFENCE_RULE_LOGGED = [
    'rule_name',
    'allowed_ssid',
    'allowed_ip_cidr',
    'max_distance_meters',
    'center_latitude',
    'center_longitude',
    'is_active',
] as const

export type GeofenceRuleRow = {
    id: number
    organization_id: number
    rule_name: string
    allowed_ssid: string | null
    allowed_ip_cidr: string | null
    max_distance_meters: number | null
    center_latitude: string | number | null
    center_longitude: string | number | null
    anchor_device_id: number | null
    is_active: boolean
    created_at: Date | null
    /** Hanya ada kalau relasi anchorDevice dimuat (index). */
    anchor_device_name?: string | null
}

/** GeofenceRuleResource -- anchor_device_name hanya kalau relasinya dimuat. */
export function geofenceRuleResource(rule: GeofenceRuleRow) {
    return {
        id: rule.id,
        organization_id: rule.organization_id,
        rule_name: rule.rule_name,
        allowed_ssid: rule.allowed_ssid,
        allowed_ip_cidr: rule.allowed_ip_cidr,
        max_distance_meters: rule.max_distance_meters,
        center_latitude: rule.center_latitude !== null ? Number(rule.center_latitude) : null,
        center_longitude: rule.center_longitude !== null ? Number(rule.center_longitude) : null,
        anchor_device_id: rule.anchor_device_id,
        ...(rule.anchor_device_name !== undefined
            ? { anchor_device_name: rule.anchor_device_name }
            : {}),
        is_active: rule.is_active,
        created_at: laravelDate(rule.created_at),
    }
}

/**
 * Nilai logOnly dari baris DB (spatie membaca model fresh() dari DB, jadi
 * desimal tetap string "-6.2000000" seperti dari PDO).
 */
export function loggedAttributesOf(row: Record<string, unknown>) {
    return Object.fromEntries(GEOFENCE_RULE_LOGGED.map((key) => [key, row[key] ?? null]))
}

/** logOnlyDirty: hanya atribut yang nilainya berubah, plus nilai lamanya. */
export function dirtyLoggedAttributes(
    before: Record<string, unknown>,
    after: Record<string, unknown>
) {
    const attributes: Record<string, unknown> = {}
    const old: Record<string, unknown> = {}
    for (const key of GEOFENCE_RULE_LOGGED) {
        const previous = before[key] ?? null
        const current = after[key] ?? null
        if (!sameValue(previous, current)) {
            attributes[key] = current
            old[key] = previous
        }
    }
    return { attributes, old }
}

/** Kesetaraan nilai ala Eloquent originalIsEquivalent(): angka dibandingkan sebagai angka. */
function sameValue(a: unknown, b: unknown): boolean {
    if (a === null || b === null) return a === b
    if (isNumeric(a) && isNumeric(b)) return Number(a) === Number(b)
    return a === b
}

function isNumeric(value: unknown): boolean {
    return (
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    )
}

/**
 * Aturan geofence per site -- padanan GeofenceRuleController di backend-api
 * (apiResource tanpa show), kontrak sama.
 */
export default class GeofenceRulesController {
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'geofence-rules.manage')) return forbidden(ctx)

        const filter = organizationFilter(access, requestedOrganizationId(ctx))
        if (filter === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melihat aturan geofence site ini'))
        }

        const { page, perPage } = paginationOf(ctx, 20)
        // with('anchorDevice'): device yang sudah di-soft-delete dianggap tidak ada.
        const query = db
            .from('geofence_rules')
            .leftJoin('devices', (join) => {
                join.on('devices.id', '=', 'geofence_rules.anchor_device_id').andOnNull(
                    'devices.deleted_at'
                )
            })
            .select('geofence_rules.*', 'devices.device_name as anchor_device_name')
            .orderBy('geofence_rules.rule_name')
        if (filter !== 'all') {
            query.whereIn('geofence_rules.organization_id', filter)
        }

        const rules = await query.paginate(page, perPage)

        return success('Daftar aturan geofence', {
            items: rules.all().map((rule) => geofenceRuleResource(rule as GeofenceRuleRow)),
            total: rules.total,
        })
    }

    async store(ctx: HttpContext) {
        // StoreGeofenceRuleRequest::authorize() jalan sebelum validasi.
        const access = await accessOf(ctx)
        if (!can(access, 'geofence-rules.manage')) return forbidden(ctx)

        const input = await ctx.request.validateUsing(storeGeofenceRuleValidator)

        const organizationId = authorizedOrganizationId(access, input.organization_id)
        if (organizationId === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang membuat aturan untuk site ini'))
        }

        // 'exists:devices,id' cuma mengecek device-nya ADA, bukan device-nya
        // milik SITE INI -- tanpa ini, admin site A bisa tanam anchor_device_id
        // milik site B, dan nama device B ikut bocor lewat anchor_device_name
        // (IDOR lintas-tenant, ditemukan lewat audit keamanan menyeluruh).
        if (
            input.anchor_device_id &&
            !(await deviceBelongsTo(input.anchor_device_id, organizationId))
        ) {
            return ctx.response.status(422).send(fail('Device anchor harus milik site yang sama'))
        }

        const now = new Date()
        const [rule] = await db
            .table('geofence_rules')
            .insert({
                organization_id: organizationId,
                rule_name: input.rule_name,
                allowed_ssid: input.allowed_ssid ?? null,
                allowed_ip_cidr: input.allowed_ip_cidr ?? null,
                max_distance_meters: input.max_distance_meters ?? null,
                center_latitude: input.center_latitude ?? null,
                center_longitude: input.center_longitude ?? null,
                anchor_device_id: input.anchor_device_id ?? null,
                is_active: true,
                created_by: access.userId,
                updated_by: access.userId,
                created_at: now,
                updated_at: now,
            })
            .returning('*')

        await logModelEvent(ctx, {
            event: 'created',
            subjectType: GEOFENCE_RULE_MORPH,
            subjectId: rule.id,
            organizationId: rule.organization_id,
            attributes: loggedAttributesOf(rule),
        })

        return ctx.response
            .status(201)
            .send(success('Aturan geofence berhasil dibuat', geofenceRuleResource(rule)))
    }

    async update(ctx: HttpContext) {
        // Route model binding (404) jalan sebelum cek izin di backend-api.
        const rule = await findRule(ctx)
        if (!rule) return notFound(ctx)

        const access = await accessOf(ctx)
        if (!can(access, 'geofence-rules.manage')) return forbidden(ctx)

        if (authorizedOrganizationId(access, rule.organization_id) === null) {
            return ctx.response.status(403).send(fail('Anda tidak berwenang mengubah aturan ini'))
        }

        const validated = await ctx.request.validateUsing(updateGeofenceRuleValidator)
        const data = Object.fromEntries(
            Object.entries(validated).filter(([, value]) => value !== undefined)
        ) as Partial<typeof validated>

        // Sama seperti store() -- 'exists' saja tidak cukup, device anchor
        // wajib milik site yang sama dengan aturan ini.
        if (
            data.anchor_device_id &&
            !(await deviceBelongsTo(data.anchor_device_id, rule.organization_id))
        ) {
            return ctx.response.status(422).send(fail('Device anchor harus milik site yang sama'))
        }

        // Eloquent hanya menyimpan (dan menggeser updated_at) kalau ada yang
        // benar-benar berubah, termasuk updated_by.
        const changes: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(data)) {
            if (!sameValue((rule as Record<string, unknown>)[key] ?? null, value ?? null)) {
                changes[key] = value
            }
        }
        if (rule.updated_by !== access.userId) {
            changes.updated_by = access.userId
        }

        let updated: GeofenceRuleRow & { updated_by: number | null } = rule
        if (Object.keys(changes).length) {
            ;[updated] = await db
                .from('geofence_rules')
                .where('id', rule.id)
                .update({ ...changes, updated_at: new Date() })
                .returning('*')

            const { attributes, old } = dirtyLoggedAttributes(rule, updated)
            // dontSubmitEmptyLogs: perubahan di luar logOnly tidak dicatat.
            if (Object.keys(attributes).length) {
                await logModelEvent(ctx, {
                    event: 'updated',
                    subjectType: GEOFENCE_RULE_MORPH,
                    subjectId: rule.id,
                    organizationId: rule.organization_id,
                    attributes,
                    old,
                })
            }
        }

        return success('Aturan geofence berhasil diperbarui', geofenceRuleResource(updated))
    }

    async destroy(ctx: HttpContext) {
        const rule = await findRule(ctx)
        if (!rule) return notFound(ctx)

        const access = await accessOf(ctx)
        if (!can(access, 'geofence-rules.manage')) return forbidden(ctx)

        if (authorizedOrganizationId(access, rule.organization_id) === null) {
            return ctx.response.status(403).send(fail('Anda tidak berwenang menghapus aturan ini'))
        }

        await db.from('geofence_rules').where('id', rule.id).delete()

        // Event 'deleted' spatie: nilai terakhir dicatat sebagai 'old' saja.
        await writeActivity(ctx, {
            logName: 'default',
            description: 'deleted',
            event: 'deleted',
            subjectType: GEOFENCE_RULE_MORPH,
            subjectId: rule.id,
            properties: { old: loggedAttributesOf(rule) },
            organizationId: rule.organization_id,
        })

        return success('Aturan geofence berhasil dihapus')
    }
}

async function findRule(
    ctx: HttpContext
): Promise<(GeofenceRuleRow & { updated_by: number | null }) | null> {
    return (await db.from('geofence_rules').where('id', ctx.params.geofence_rule).first()) ?? null
}

/** Device (belum di-soft-delete) dengan id ini milik site tersebut. */
async function deviceBelongsTo(deviceId: number, organizationId: number): Promise<boolean> {
    const device = await db
        .from('devices')
        .where('id', deviceId)
        .where('organization_id', organizationId)
        .whereNull('deleted_at')
        .first()
    return Boolean(device)
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang melakukan tindakan ini'))
}

function notFound(ctx: HttpContext) {
    return ctx.response.status(404).send(fail('Data tidak ditemukan'))
}
