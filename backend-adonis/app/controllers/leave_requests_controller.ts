import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import vine from '@vinejs/vine'
import { accessOf } from '#services/access'
import { writeActivity } from '#services/activity_log'
import { fail, success } from '#services/api_response'
import { DATE_PATTERN, dateColumn, datesBetween, localDate } from '#services/local_time'
import { isManager, managedSites, managesSite } from '#services/managed_sites'
import { raiseAlert } from '#services/work_alerts'

export const LEAVE_TYPES = { izin: 'Izin', sakit: 'Sakit', cuti: 'Cuti' } as const
type LeaveType = keyof typeof LEAVE_TYPES
const MAX_DAYS = 30

const storeValidator = vine.compile(
    vine.object({
        type: vine.enum(Object.keys(LEAVE_TYPES) as LeaveType[]),
        start_date: vine.string().regex(DATE_PATTERN),
        end_date: vine.string().regex(DATE_PATTERN),
        reason: vine.string().trim().minLength(3).maxLength(1000),
    })
)

const reviewValidator = vine.compile(
    vine.object({
        status: vine.enum(['approved', 'rejected'] as const),
        note: vine.string().trim().maxLength(500).optional(),
    })
)

type LeaveRow = {
    id: number
    user_id: number
    organization_id: number | null
    type: LeaveType
    start_date: Date | string
    end_date: Date | string
    reason: string
    status: string
    reviewed_by: number | null
    reviewed_at: Date | null
    review_note: string | null
    created_at: Date
    user_name?: string
    site_name?: string | null
    reviewer_name?: string | null
}

function resource(row: LeaveRow) {
    const start = dateColumn(row.start_date)
    const end = dateColumn(row.end_date)
    return {
        id: row.id,
        user_id: row.user_id,
        user_name: row.user_name ?? null,
        organization_id: row.organization_id,
        site_name: row.site_name ?? null,
        type: row.type,
        type_label: LEAVE_TYPES[row.type] ?? row.type,
        start_date: start,
        end_date: end,
        days: datesBetween(start, end).length,
        reason: row.reason,
        status: row.status,
        reviewed_by_name: row.reviewer_name ?? null,
        reviewed_at: row.reviewed_at,
        review_note: row.review_note,
        created_at: row.created_at,
    }
}

function baseQuery() {
    return db
        .from('leave_requests')
        .join('users', 'users.id', 'leave_requests.user_id')
        .leftJoin('organizations', 'organizations.id', 'leave_requests.organization_id')
        .leftJoin('users as reviewers', 'reviewers.id', 'leave_requests.reviewed_by')
        .select(
            'leave_requests.*',
            'users.name as user_name',
            'organizations.name as site_name',
            'reviewers.name as reviewer_name'
        )
}

/**
 * Pengajuan izin, sakit, dan cuti. Staf mengajukan untuk dirinya; pengelola
 * site menyetujui atau menolak. Hari yang disetujui tercatat di absensi
 * sebagai izin/sakit/cuti, bukan tidak masuk.
 */
export default class LeaveRequestsController {
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const mine: LeaveRow[] = await baseQuery()
            .where('leave_requests.user_id', access.userId)
            .orderBy('leave_requests.start_date', 'desc')
            .limit(50)

        const canReview = isManager(access)
        let review: LeaveRow[] = []
        if (canReview) {
            const own = managedSites(access)
            const status = ctx.request.input('status', 'pending')
            review = await baseQuery()
                .whereNot('leave_requests.user_id', access.userId)
                .if(own !== 'all', (query) =>
                    query.whereIn('leave_requests.organization_id', own as number[])
                )
                .if(['pending', 'approved', 'rejected', 'cancelled'].includes(status), (query) =>
                    query.where('leave_requests.status', status)
                )
                .orderBy('leave_requests.start_date', status === 'pending' ? 'asc' : 'desc')
                .limit(200)
        }
        const pendingCount = canReview
            ? await db
                  .from('leave_requests')
                  .where('status', 'pending')
                  .whereNot('user_id', access.userId)
                  .if(managedSites(access) !== 'all', (query) =>
                      query.whereIn('organization_id', managedSites(access) as number[])
                  )
                  .count('* as total')
                  .first()
            : null

        return success('Izin & cuti', {
            types: Object.entries(LEAVE_TYPES).map(([value, label]) => ({ value, label })),
            can_review: canReview,
            pending_count: Number(pendingCount?.total ?? 0),
            mine: mine.map(resource),
            review: review.map(resource),
        })
    }

    async store(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const input = await ctx.request.validateUsing(storeValidator)
        if (input.end_date < input.start_date) {
            return ctx.response
                .status(422)
                .send(fail('Tanggal selesai harus setelah tanggal mulai'))
        }
        if (datesBetween(input.start_date, input.end_date).length > MAX_DAYS) {
            return ctx.response.status(422).send(fail(`Satu pengajuan maksimal ${MAX_DAYS} hari`))
        }
        // Izin & cuti diajukan sebelumnya; sakit boleh menyusul sampai 7 hari ke belakang.
        const earliest = localDate(new Date(Date.now() - 7 * 86_400_000))
        if (input.start_date < (input.type === 'sakit' ? earliest : localDate())) {
            return ctx.response
                .status(422)
                .send(
                    fail(
                        input.type === 'sakit'
                            ? 'Pengajuan sakit paling lambat 7 hari setelahnya'
                            : 'Izin & cuti tidak bisa diajukan untuk tanggal yang sudah lewat'
                    )
                )
        }
        const overlap = await db
            .from('leave_requests')
            .where('user_id', access.userId)
            .whereIn('status', ['pending', 'approved'])
            .where('start_date', '<=', input.end_date)
            .where('end_date', '>=', input.start_date)
            .first()
        if (overlap) {
            return ctx.response
                .status(422)
                .send(fail('Sudah ada pengajuan lain di tanggal tersebut'))
        }

        const user = ctx.authUser!
        const now = new Date()
        const [row] = await db
            .table('leave_requests')
            .insert({
                user_id: user.id,
                organization_id: user.organizationId,
                ...input,
                status: 'pending',
                created_at: now,
                updated_at: now,
            })
            .returning('*')
        await writeActivity(ctx, {
            logName: 'leave_requests',
            description: `Mengajukan ${LEAVE_TYPES[input.type].toLowerCase()} ${input.start_date} s/d ${input.end_date}`,
            event: 'created',
            subjectType: null,
            subjectId: row.id,
            properties: input,
            organizationId: user.organizationId,
        })
        if (user.organizationId !== null) {
            await raiseAlert({
                organizationId: user.organizationId,
                userId: user.id,
                type: 'leave_request',
                key: `leave_request:${row.id}`,
                message: `📝 ${user.name} mengajukan ${LEAVE_TYPES[input.type].toLowerCase()} ${input.start_date}${input.end_date !== input.start_date ? ` s/d ${input.end_date}` : ''}: ${input.reason}\nSetujui atau tolak di menu Izin & cuti.`,
                now,
            })
        }
        const [created] = await baseQuery().where('leave_requests.id', row.id)
        return ctx.response.status(201).send(success('Pengajuan terkirim', resource(created)))
    }

    async review(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const leave = await findLeave(ctx.params.id)
        if (!leave) return ctx.response.status(404).send(fail('Pengajuan tidak ditemukan'))
        if (!managesSite(access, leave.organization_id)) {
            return ctx.response.status(403).send(fail('Anda tidak mengelola site staf ini'))
        }
        if (leave.user_id === access.userId && !access.roles.includes('super_admin')) {
            return ctx.response
                .status(403)
                .send(fail('Pengajuan sendiri disetujui oleh pengelola lain'))
        }
        if (leave.status !== 'pending') {
            return ctx.response.status(422).send(fail('Pengajuan ini sudah diproses'))
        }
        const input = await ctx.request.validateUsing(reviewValidator)
        const now = new Date()
        await db
            .from('leave_requests')
            .where('id', leave.id)
            .update({
                status: input.status,
                reviewed_by: access.userId,
                reviewed_at: now,
                review_note: input.note || null,
                updated_at: now,
            })
        await writeActivity(ctx, {
            logName: 'leave_requests',
            description: `${input.status === 'approved' ? 'Menyetujui' : 'Menolak'} ${LEAVE_TYPES[leave.type].toLowerCase()} ${leave.user_name}`,
            event: 'updated',
            subjectType: null,
            subjectId: leave.id,
            properties: input,
            organizationId: leave.organization_id,
        })
        const [updated] = await baseQuery().where('leave_requests.id', leave.id)
        return success(
            input.status === 'approved' ? 'Pengajuan disetujui' : 'Pengajuan ditolak',
            resource(updated)
        )
    }

    /** Batalkan pengajuan sendiri yang belum lewat. */
    async cancel(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const leave = await findLeave(ctx.params.id)
        if (!leave || leave.user_id !== access.userId) {
            return ctx.response.status(404).send(fail('Pengajuan tidak ditemukan'))
        }
        if (!['pending', 'approved'].includes(leave.status)) {
            return ctx.response.status(422).send(fail('Pengajuan ini sudah tidak aktif'))
        }
        if (leave.status === 'approved' && dateColumn(leave.start_date) <= localDate()) {
            return ctx.response
                .status(422)
                .send(fail('Izin yang sudah berjalan tidak bisa dibatalkan'))
        }
        await db
            .from('leave_requests')
            .where('id', leave.id)
            .update({ status: 'cancelled', updated_at: new Date() })
        await writeActivity(ctx, {
            logName: 'leave_requests',
            description: `Membatalkan pengajuan ${LEAVE_TYPES[leave.type].toLowerCase()}`,
            event: 'updated',
            subjectType: null,
            subjectId: leave.id,
            properties: {},
            organizationId: leave.organization_id,
        })
        return success('Pengajuan dibatalkan')
    }
}

async function findLeave(id: unknown): Promise<LeaveRow | null> {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) return null
    const [row] = await baseQuery().where('leave_requests.id', Number(id))
    return row ?? null
}

/** Izin/sakit/cuti yang disetujui hari ini -> jenisnya, per staf. */
export async function leaveToday(userIds: number[]): Promise<Map<number, string>> {
    if (!userIds.length) return new Map()
    const today = localDate()
    const rows = await db
        .from('leave_requests')
        .whereIn('user_id', userIds)
        .where('status', 'approved')
        .where('start_date', '<=', today)
        .where('end_date', '>=', today)
        .select('user_id', 'type')
    return new Map(rows.map((row) => [Number(row.user_id), row.type as string]))
}
