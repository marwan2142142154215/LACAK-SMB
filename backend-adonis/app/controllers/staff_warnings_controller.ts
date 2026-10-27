import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import vine from '@vinejs/vine'
import { accessOf } from '#services/access'
import { writeActivity } from '#services/activity_log'
import { fail, success } from '#services/api_response'
import { isManager, managedSites, managesSite } from '#services/managed_sites'
import { roleNamesOf } from '#services/permissions'

export const WARNING_LEVELS = { teguran: 'Teguran', keras: 'Peringatan keras' } as const
type WarningLevel = keyof typeof WARNING_LEVELS

const storeValidator = vine.compile(
    vine.object({
        user_id: vine.number().withoutDecimals().positive(),
        level: vine.enum(Object.keys(WARNING_LEVELS) as WarningLevel[]),
        message: vine.string().trim().minLength(3).maxLength(1000),
    })
)

type WarningRow = {
    id: number
    user_id: number
    issued_by: number | null
    organization_id: number | null
    level: WarningLevel
    message: string
    acknowledged_at: Date | null
    created_at: Date
    issuer_name?: string | null
    user_name?: string | null
}

function resource(row: WarningRow) {
    return {
        id: row.id,
        user_id: row.user_id,
        user_name: row.user_name ?? null,
        level: row.level,
        level_label: WARNING_LEVELS[row.level] ?? row.level,
        message: row.message,
        issuer_name: row.issuer_name ?? null,
        acknowledged_at: row.acknowledged_at,
        created_at: row.created_at,
    }
}

function withNames() {
    return db
        .from('staff_warnings')
        .leftJoin('users as issuer', 'issuer.id', 'staff_warnings.issued_by')
        .join('users as target', 'target.id', 'staff_warnings.user_id')
        .select('staff_warnings.*', 'issuer.name as issuer_name', 'target.name as user_name')
}

/**
 * Peringatan dari leader ke atas untuk staf di site yang ia kelola. Staf
 * melihatnya sebagai popup yang wajib dikonfirmasi; pemberi peringatan
 * melihat riwayat & kapan staf menekan "Saya mengerti".
 */
export default class StaffWarningsController {
    /** Peringatan milik user yang login dan belum dikonfirmasi (paling lama dulu). */
    async pending(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const rows: WarningRow[] = await withNames()
            .where('staff_warnings.user_id', access.userId)
            .whereNull('staff_warnings.acknowledged_at')
            .orderBy('staff_warnings.id')
        return success('Peringatan belum dikonfirmasi', { items: rows.map(resource) })
    }

    async acknowledge(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const id = ctx.params.id
        if (typeof id !== 'string' || !/^\d+$/.test(id)) {
            return ctx.response.status(404).send(fail('Peringatan tidak ditemukan'))
        }
        const updated = await db
            .from('staff_warnings')
            .where('id', Number(id))
            .where('user_id', access.userId)
            .update({
                acknowledged_at: db.raw('COALESCE(acknowledged_at, ?)', [new Date()]),
                updated_at: new Date(),
            })
        if (!updated) return ctx.response.status(404).send(fail('Peringatan tidak ditemukan'))
        return success('Peringatan dikonfirmasi')
    }

    /** Riwayat peringatan (pengelola site); ?user_id= untuk satu staf. */
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!isManager(access)) {
            return ctx.response
                .status(403)
                .send(fail('Hanya leader ke atas yang bisa melihat peringatan'))
        }
        const query = withNames().orderBy('staff_warnings.id', 'desc').limit(100)
        const sites = managedSites(access)
        if (sites !== 'all') query.whereIn('staff_warnings.organization_id', sites)
        const userId = Number(ctx.request.input('user_id'))
        if (Number.isInteger(userId) && userId > 0) query.where('staff_warnings.user_id', userId)
        const rows: WarningRow[] = await query
        return success('Riwayat peringatan', {
            levels: Object.entries(WARNING_LEVELS).map(([value, label]) => ({ value, label })),
            items: rows.map(resource),
        })
    }

    async store(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!isManager(access)) {
            return ctx.response
                .status(403)
                .send(fail('Hanya leader ke atas yang bisa memberi peringatan'))
        }
        const input = await ctx.request.validateUsing(storeValidator)
        if (input.user_id === access.userId) {
            return ctx.response
                .status(422)
                .send(fail('Tidak bisa memberi peringatan ke diri sendiri'))
        }
        const target = await db
            .from('users')
            .where('id', input.user_id)
            .where('is_active', true)
            .select('id', 'name', 'organization_id')
            .first()
        if (!target || !managesSite(access, target.organization_id ?? null)) {
            return ctx.response
                .status(404)
                .send(fail('Staf tidak ditemukan di site yang Anda kelola'))
        }
        const targetRoles = await roleNamesOf(target.id)
        if (targetRoles.includes('super_admin')) {
            return ctx.response.status(403).send(fail('Super Admin tidak bisa diberi peringatan'))
        }

        const now = new Date()
        const [row] = await db
            .table('staff_warnings')
            .insert({
                user_id: target.id,
                issued_by: access.userId,
                organization_id: target.organization_id ?? null,
                level: input.level,
                message: input.message,
                created_at: now,
                updated_at: now,
            })
            .returning('*')
        await writeActivity(ctx, {
            logName: 'staff_warnings',
            description: `Memberi ${WARNING_LEVELS[input.level].toLowerCase()} ke ${target.name}`,
            event: 'created',
            subjectType: null,
            subjectId: row.id,
            properties: { user_id: target.id, level: input.level },
            organizationId: target.organization_id ?? null,
        })
        return ctx.response.status(201).send(success('Peringatan terkirim', { id: row.id }))
    }
}
