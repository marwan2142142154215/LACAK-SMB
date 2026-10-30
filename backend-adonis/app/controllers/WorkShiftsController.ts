import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import vine from '@vinejs/vine'
import { accessOf } from '#services/access'
import { writeActivity } from '#services/activity_log'
import { fail, success } from '#services/api_response'
import { shiftRow } from '#services/attendance'
import { TIME_PATTERN } from '#services/local_time'
import { isManager, managedSites, managesSite } from '#services/managed_sites'

const shiftValidator = vine.compile(
    vine.object({
        organization_id: vine.number().withoutDecimals().positive(),
        name: vine.string().trim().minLength(1).maxLength(80),
        start_time: vine.string().regex(TIME_PATTERN),
        end_time: vine.string().regex(TIME_PATTERN),
        days: vine.array(vine.number().withoutDecimals().min(1).max(7)).minLength(1).maxLength(7),
        late_tolerance_minutes: vine.number().withoutDecimals().min(0).max(240),
    })
)

const assignValidator = vine.compile(
    vine.object({
        user_ids: vine
            .array(vine.number().withoutDecimals().positive())
            .minLength(1)
            .maxLength(500),
        // null = lepas shift.
        work_shift_id: vine.number().withoutDecimals().positive().nullable(),
    })
)

/**
 * Shift kerja per site & penempatan staf ke shift. Dikelola root, admin,
 * leader, dan admin site untuk site yang mereka pegang.
 */
export default class WorkShiftsController {
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!isManager(access)) return forbidden(ctx)

        const sites = await sitesOf(managedSites(access))
        const requested = Number(ctx.request.input('organization_id')) || null
        const siteIds = requested
            ? managesSite(access, requested)
                ? [requested]
                : []
            : sites.map((site) => site.id)
        if (requested && !siteIds.length) {
            return ctx.response.status(403).send(fail('Anda tidak mengelola site ini'))
        }

        const shifts = siteIds.length
            ? await db
                  .from('work_shifts')
                  .whereIn('organization_id', siteIds)
                  .orderBy('organization_id')
                  .orderBy('start_time')
                  .select(
                      'work_shifts.*',
                      db.raw(
                          '(select count(*) from staff_shifts where staff_shifts.work_shift_id = work_shifts.id)::int as staff_count'
                      )
                  )
            : []
        const staff = siteIds.length
            ? await db
                  .from('users')
                  .leftJoin('staff_shifts', 'staff_shifts.user_id', 'users.id')
                  .whereIn('users.organization_id', siteIds)
                  .whereNull('users.deleted_at')
                  .where('users.is_active', true)
                  .orderBy('users.name')
                  .select(
                      'users.id',
                      'users.name',
                      'users.organization_id',
                      'staff_shifts.work_shift_id'
                  )
            : []

        return success('Shift kerja', {
            sites,
            shifts: shifts.map((row) => ({ ...shiftRow(row), staff_count: row.staff_count })),
            staff: staff.map((row) => ({
                id: Number(row.id),
                name: row.name,
                organization_id: Number(row.organization_id),
                work_shift_id: row.work_shift_id === null ? null : Number(row.work_shift_id),
            })),
        })
    }

    async store(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const input = await ctx.request.validateUsing(shiftValidator)
        if (!managesSite(access, input.organization_id)) return forbidden(ctx)

        const now = new Date()
        const [row] = await db
            .table('work_shifts')
            .insert({
                ...input,
                days: JSON.stringify([...new Set(input.days)].sort()),
                created_by: access.userId,
                created_at: now,
                updated_at: now,
            })
            .returning('*')
        await writeActivity(ctx, {
            logName: 'work_shifts',
            description: `Membuat shift "${input.name}" (${input.start_time}–${input.end_time})`,
            event: 'created',
            subjectType: null,
            subjectId: row.id,
            properties: input,
            organizationId: input.organization_id,
        })
        return ctx.response.status(201).send(success('Shift dibuat', shiftRow(row)))
    }

    async update(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const shift = await findShift(ctx.params.id)
        if (!shift) return ctx.response.status(404).send(fail('Shift tidak ditemukan'))
        const input = await ctx.request.validateUsing(shiftValidator)
        if (!managesSite(access, shift.organization_id)) return forbidden(ctx)
        if (input.organization_id !== shift.organization_id) {
            return ctx.response.status(422).send(fail('Site shift tidak bisa dipindah'))
        }

        await db
            .from('work_shifts')
            .where('id', shift.id)
            .update({
                name: input.name,
                start_time: input.start_time,
                end_time: input.end_time,
                days: JSON.stringify([...new Set(input.days)].sort()),
                late_tolerance_minutes: input.late_tolerance_minutes,
                updated_at: new Date(),
            })
        await writeActivity(ctx, {
            logName: 'work_shifts',
            description: `Mengubah shift "${input.name}"`,
            event: 'updated',
            subjectType: null,
            subjectId: shift.id,
            properties: input,
            organizationId: shift.organization_id,
        })
        return success('Shift diperbarui', await findShift(String(shift.id)))
    }

    async destroy(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const shift = await findShift(ctx.params.id)
        if (!shift) return ctx.response.status(404).send(fail('Shift tidak ditemukan'))
        if (!managesSite(access, shift.organization_id)) return forbidden(ctx)

        await db.from('work_shifts').where('id', shift.id).delete()
        await writeActivity(ctx, {
            logName: 'work_shifts',
            description: `Menghapus shift "${shift.name}"`,
            event: 'deleted',
            subjectType: null,
            subjectId: shift.id,
            properties: {},
            organizationId: shift.organization_id,
        })
        return success('Shift dihapus')
    }

    /** Pasang (atau lepas) shift untuk beberapa staf sekaligus. */
    async assign(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!isManager(access)) return forbidden(ctx)
        const input = await ctx.request.validateUsing(assignValidator)
        const userIds = [...new Set(input.user_ids)]

        const users = await db
            .from('users')
            .whereIn('id', userIds)
            .whereNull('deleted_at')
            .select('id', 'organization_id')
        if (
            users.length !== userIds.length ||
            users.some((user) => !managesSite(access, user.organization_id))
        ) {
            return ctx.response.status(403).send(fail('Ada staf yang tidak berada di site Anda'))
        }

        const shift = input.work_shift_id ? await findShift(String(input.work_shift_id)) : null
        if (input.work_shift_id && !shift) {
            return ctx.response.status(404).send(fail('Shift tidak ditemukan'))
        }
        if (shift && users.some((user) => Number(user.organization_id) !== shift.organization_id)) {
            return ctx.response
                .status(422)
                .send(fail('Shift hanya bisa dipasang ke staf di site yang sama'))
        }

        const now = new Date()
        await db.transaction(async (trx) => {
            await trx.from('staff_shifts').whereIn('user_id', userIds).delete()
            if (shift) {
                await trx.table('staff_shifts').multiInsert(
                    userIds.map((userId) => ({
                        user_id: userId,
                        work_shift_id: shift.id,
                        created_at: now,
                        updated_at: now,
                    }))
                )
            }
        })
        await writeActivity(ctx, {
            logName: 'work_shifts',
            description: shift
                ? `Memasang shift "${shift.name}" ke ${userIds.length} staf`
                : `Melepas shift dari ${userIds.length} staf`,
            event: 'updated',
            subjectType: null,
            subjectId: shift?.id ?? null,
            properties: { user_ids: userIds },
            organizationId: shift?.organization_id ?? null,
        })
        return success(shift ? 'Shift dipasang' : 'Shift dilepas')
    }
}

async function findShift(id: unknown) {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) return null
    const row = await db.from('work_shifts').where('id', Number(id)).first()
    return row ? shiftRow(row) : null
}

/** Site aktif untuk pilihan di dashboard. */
export async function sitesOf(ids: number[] | 'all') {
    const query = db
        .from('organizations')
        .where('is_active', true)
        .whereNull('deleted_at')
        .orderBy('name')
        .select('id', 'name')
    if (ids !== 'all') {
        if (!ids.length) return []
        query.whereIn('id', ids)
    }
    const rows = await query
    return rows.map((row) => ({ id: Number(row.id), name: row.name as string }))
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang mengelola shift'))
}
