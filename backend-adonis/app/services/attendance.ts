import db from '@adonisjs/lucid/services/db'
import { atLocal, addDays, dateColumn, datesBetween, isoWeekday } from '#services/local_time'
import { summarize, type PresenceEvent } from '#services/work_presence'

/**
 * Absensi dari Live Kerja: tiap staf per hari dibandingkan dengan shift-nya
 * -- hadir, terlambat, pulang cepat, lembur, tidak masuk, izin/sakit/cuti.
 * Jam kerja dihitung dengan summarize() yang sama dengan log kerja.
 */

export type Shift = {
    id: number
    organization_id: number
    name: string
    start_time: string
    end_time: string
    days: number[]
    late_tolerance_minutes: number
}

export type ApprovedLeave = {
    user_id: number
    type: string
    start_date: string
    end_date: string
}

export type AttendanceStatus =
    'present' | 'late' | 'absent' | 'not_started' | 'upcoming' | 'leave' | 'off'

export type AttendanceDay = {
    date: string
    user_id: number
    user_name: string | null
    organization_id: number | null
    shift: { id: number; name: string; start_time: string; end_time: string } | null
    scheduled: boolean
    status: AttendanceStatus
    leave_type: string | null
    first_start_at: string | null
    last_end_at: string | null
    work_seconds: number
    break_seconds: number
    late_minutes: number
    early_leave_minutes: number
    overtime_minutes: number
    face_lost_count: number
}

/** Lembur baru dihitung kalau kerja melewati akhir shift selama ini. */
export const OVERTIME_MIN_MINUTES = 30
/** Jendela satu hari kerja: sekian jam sebelum shift mulai sampai sekian jam sesudah selesai. */
const WINDOW_BEFORE_HOURS = 4
const WINDOW_AFTER_HOURS = 6
const HOUR = 3_600_000
const MINUTE = 60_000

/** Mulai & selesai shift pada tanggal ini (shift malam selesai keesokan harinya). */
export function shiftBounds(shift: Pick<Shift, 'start_time' | 'end_time'>, date: string) {
    const start = atLocal(date, shift.start_time)
    const endDate = shift.end_time <= shift.start_time ? addDays(date, 1) : date
    return { start, end: atLocal(endDate, shift.end_time) }
}

/** Rentang kejadian yang dihitung untuk satu hari. */
export function dayWindow(shift: Shift | null, date: string) {
    if (!shift) return { from: atLocal(date, '00:00'), to: atLocal(addDays(date, 1), '00:00') }
    const { start, end } = shiftBounds(shift, date)
    return {
        from: new Date(start.getTime() - WINDOW_BEFORE_HOURS * HOUR),
        to: new Date(end.getTime() + WINDOW_AFTER_HOURS * HOUR),
    }
}

const minutesBetween = (later: number, earlier: number) =>
    Math.max(0, Math.round((later - earlier) / MINUTE))

/**
 * Satu staf, satu hari.
 *
 * @param events kejadian staf ini, urut waktu (boleh lebih luas dari harinya)
 * @param before kejadian terakhir staf ini sebelum `events`, kalau ada
 */
export function attendanceDay(input: {
    date: string
    user: { id: number; name: string | null; organization_id: number | null }
    shift: Shift | null
    leave: ApprovedLeave | null
    events: PresenceEvent[]
    before: PresenceEvent | null
    now: Date
}): AttendanceDay {
    const { date, user, shift, leave, now } = input
    const scheduled = !!shift && shift.days.includes(isoWeekday(date))
    const window = dayWindow(scheduled ? shift : null, date)

    let before = input.before
    const inWindow: PresenceEvent[] = []
    for (const event of input.events) {
        const at = event.occurred_at.getTime()
        if (at < window.from.getTime()) before = event
        else if (at < window.to.getTime()) inWindow.push(event)
    }

    const [summary] = summarize(
        inWindow,
        new Map(before ? [[user.id, before]] : []),
        window.from,
        window.to,
        now
    )
    const starts = inWindow.filter((event) => event.type === 'work_start')
    const ends = inWindow.filter((event) => event.status === 'offline')
    // Masih bekerja dari hari sebelumnya (sesi belum ditutup saat jendela mulai).
    const carriedOver = !!before && before.status !== 'offline'
    const firstStart = starts[0]?.occurred_at ?? (carriedOver ? window.from : null)
    const lastEvent = inWindow[inWindow.length - 1] ?? before
    const stillWorking = !!lastEvent && lastEvent.status !== 'offline'
    const lastEnd = stillWorking ? null : (ends[ends.length - 1]?.occurred_at ?? null)

    const day: AttendanceDay = {
        date,
        user_id: user.id,
        user_name: user.name,
        organization_id: user.organization_id,
        shift: shift
            ? {
                  id: shift.id,
                  name: shift.name,
                  start_time: shift.start_time,
                  end_time: shift.end_time,
              }
            : null,
        scheduled,
        status: 'off',
        leave_type: leave?.type ?? null,
        first_start_at: firstStart ? firstStart.toISOString() : null,
        last_end_at: lastEnd ? lastEnd.toISOString() : null,
        work_seconds: summary?.work_seconds ?? 0,
        break_seconds: summary?.break_seconds ?? 0,
        late_minutes: 0,
        early_leave_minutes: 0,
        overtime_minutes: 0,
        face_lost_count: summary?.face_lost_count ?? 0,
    }

    const worked = !!firstStart
    if (leave && !worked) {
        day.status = 'leave'
        return day
    }
    if (!scheduled || !shift) {
        day.status = worked ? 'present' : 'off'
        return day
    }

    const bounds = shiftBounds(shift, date)
    const lateAfter = bounds.start.getTime() + shift.late_tolerance_minutes * MINUTE
    if (!worked) {
        if (now.getTime() < lateAfter) day.status = 'upcoming'
        else if (now.getTime() < bounds.end.getTime()) day.status = 'not_started'
        else day.status = 'absent'
        return day
    }

    const startedAt = firstStart!.getTime()
    if (startedAt > lateAfter) day.late_minutes = minutesBetween(startedAt, bounds.start.getTime())
    day.status = day.late_minutes > 0 ? 'late' : 'present'

    const endedAt = lastEnd ? lastEnd.getTime() : Math.min(now.getTime(), window.to.getTime())
    if (lastEnd && endedAt < bounds.end.getTime()) {
        day.early_leave_minutes = minutesBetween(bounds.end.getTime(), endedAt)
    }
    const overtime = minutesBetween(endedAt, bounds.end.getTime())
    if (overtime >= OVERTIME_MIN_MINUTES) day.overtime_minutes = overtime

    return day
}

type StaffRow = { id: number; name: string | null; organization_id: number | null }

/** Shift tiap staf (yang punya shift). */
export async function shiftsOfUsers(userIds: number[]): Promise<Map<number, Shift>> {
    if (!userIds.length) return new Map()
    const rows = await db
        .from('staff_shifts')
        .join('work_shifts', 'work_shifts.id', 'staff_shifts.work_shift_id')
        .whereIn('staff_shifts.user_id', userIds)
        .select('staff_shifts.user_id', 'work_shifts.*')
    return new Map(rows.map((row) => [Number(row.user_id), shiftRow(row)]))
}

export function shiftRow(row: Record<string, any>): Shift {
    return {
        id: Number(row.id),
        organization_id: Number(row.organization_id),
        name: row.name,
        start_time: row.start_time,
        end_time: row.end_time,
        days: (typeof row.days === 'string' ? JSON.parse(row.days) : row.days).map(Number),
        late_tolerance_minutes: Number(row.late_tolerance_minutes),
    }
}

/** Izin/sakit/cuti yang disetujui dan menyentuh rentang tanggal ini. */
export async function approvedLeaves(
    userIds: number[],
    from: string,
    to: string
): Promise<ApprovedLeave[]> {
    if (!userIds.length) return []
    const rows = await db
        .from('leave_requests')
        .whereIn('user_id', userIds)
        .where('status', 'approved')
        .where('start_date', '<=', to)
        .where('end_date', '>=', from)
        .select('user_id', 'type', 'start_date', 'end_date')
    return rows.map((row) => ({
        user_id: Number(row.user_id),
        type: row.type,
        start_date: dateColumn(row.start_date),
        end_date: dateColumn(row.end_date),
    }))
}

export function leaveOn(leaves: ApprovedLeave[], userId: number, date: string) {
    return (
        leaves.find(
            (leave) =>
                leave.user_id === userId && leave.start_date <= date && leave.end_date >= date
        ) ?? null
    )
}

/** Rekap absensi staf ini untuk tanggal from..to (lokal, keduanya ikut). */
export async function attendanceReport(
    staff: StaffRow[],
    from: string,
    to: string,
    now: Date = new Date()
): Promise<AttendanceDay[]> {
    if (!staff.length) return []
    const userIds = staff.map((member) => member.id)
    const [shifts, leaves] = await Promise.all([
        shiftsOfUsers(userIds),
        approvedLeaves(userIds, from, to),
    ])

    // Satu hari sebelum & sesudah: cukup untuk jendela shift malam.
    const rangeFrom = atLocal(addDays(from, -1), '00:00')
    const rangeTo = atLocal(addDays(to, 2), '00:00')
    const columns = [
        'work_session_events.id',
        'work_session_events.organization_id',
        'work_session_events.user_id',
        'work_session_events.type',
        'work_session_events.status',
        'work_session_events.occurred_at',
    ]
    const events: PresenceEvent[] = await db
        .from('work_session_events')
        .whereIn('user_id', userIds)
        .whereBetween('occurred_at', [rangeFrom, rangeTo])
        .orderBy('occurred_at')
        .orderBy('id')
        .select(columns)
    const beforeRows: PresenceEvent[] = await db
        .from('work_session_events')
        .whereIn(
            'id',
            db
                .from('work_session_events')
                .whereIn('user_id', userIds)
                .where('occurred_at', '<', rangeFrom)
                .groupBy('user_id')
                .max('id')
        )
        .select(columns)

    const eventsByUser = new Map<number, PresenceEvent[]>()
    for (const event of events) {
        const list = eventsByUser.get(event.user_id) ?? []
        list.push({ ...event, user_name: null })
        eventsByUser.set(event.user_id, list)
    }
    const beforeByUser = new Map(beforeRows.map((event) => [event.user_id, event]))

    const dates = datesBetween(from, to)
    const rows: AttendanceDay[] = []
    for (const member of staff) {
        for (const date of dates) {
            rows.push(
                attendanceDay({
                    date,
                    user: member,
                    shift: shifts.get(member.id) ?? null,
                    leave: leaveOn(leaves, member.id, date),
                    events: eventsByUser.get(member.id) ?? [],
                    before: beforeByUser.get(member.id) ?? null,
                    now,
                })
            )
        }
    }
    return rows
}

/** Staf aktif (selain root) di site-site ini. */
export async function staffOfSites(organizationIds: number[] | 'all'): Promise<StaffRow[]> {
    const query = db
        .from('users')
        .whereNull('deleted_at')
        .where('is_active', true)
        .whereNotNull('organization_id')
        .orderBy('name')
        .select('id', 'name', 'organization_id')
    if (organizationIds !== 'all') {
        if (!organizationIds.length) return []
        query.whereIn('organization_id', organizationIds)
    }
    return query
}
