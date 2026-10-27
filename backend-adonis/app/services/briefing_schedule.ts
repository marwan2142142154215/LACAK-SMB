import db from '@adonisjs/lucid/services/db'
import { roleNamesOf } from '#services/permissions'
import { closeBriefingRoom, type BriefingRow } from '#services/briefing'
import {
    addDays,
    atLocal,
    dateColumn,
    isoWeekday,
    localDate,
    localTime,
} from '#services/local_time'
import { raiseAlert } from '#services/work_alerts'

/**
 * Briefing terjadwal: tiap menit scheduler mengirim pengingat 10 menit
 * sebelumnya, membuka briefing tepat pada jamnya (peserta bisa langsung
 * Gabung walau pemimpin belum masuk), dan menutup briefing terjadwal yang
 * sudah lewat durasinya dan ruangnya kosong.
 */

export const RECURRENCES = {
    once: 'Sekali',
    daily: 'Setiap hari',
    weekdays: 'Senin–Jumat',
    weekly: 'Setiap minggu',
} as const
export type Recurrence = keyof typeof RECURRENCES

export const REMINDER_MINUTES = 10
/** Briefing terjadwal tetap dibuka kalau scheduler telat sampai selama ini. */
const LATE_START_MINUTES = 30
/** Batas akhir: ditutup walau masih ada peserta di dalam. */
const HARD_STOP_MINUTES = 120
const MINUTE = 60_000

export type ScheduleRow = {
    id: number
    title: string
    host_user_id: number
    allowed_roles: string[]
    allowed_organization_ids: number[]
    invited_user_ids: number[]
    recurrence: Recurrence
    start_date: string | Date
    start_time: string
    duration_minutes: number
    next_run_at: Date | null
    reminded_at: Date | null
    is_active: boolean
}

function occursOn(schedule: Pick<ScheduleRow, 'recurrence' | 'start_date'>, date: string) {
    const first = dateColumn(schedule.start_date)
    if (date < first) return false
    switch (schedule.recurrence) {
        case 'once':
            return date === first
        case 'daily':
            return true
        case 'weekdays':
            return isoWeekday(date) <= 5
        case 'weekly':
            return isoWeekday(date) === isoWeekday(first)
    }
}

/** Waktu briefing berikutnya setelah `after`, atau null kalau tidak ada lagi. */
export function nextRunAt(
    schedule: Pick<ScheduleRow, 'recurrence' | 'start_date' | 'start_time'>,
    after: Date
): Date | null {
    const first = dateColumn(schedule.start_date)
    let date = localDate(after) > first ? localDate(after) : first
    for (let i = 0; i < 8; i++, date = addDays(date, 1)) {
        if (!occursOn(schedule, date)) continue
        const at = atLocal(date, schedule.start_time)
        if (at.getTime() > after.getTime()) return at
    }
    return null
}

/** Jadwal dalam bentuk briefing -- dipakai canJoinBriefing untuk daftar Mendatang. */
export function asBriefing(schedule: ScheduleRow): BriefingRow {
    return {
        id: schedule.id,
        title: schedule.title,
        host_user_id: schedule.host_user_id,
        allowed_roles: schedule.allowed_roles,
        allowed_organization_ids: schedule.allowed_organization_ids,
        invited_user_ids: schedule.invited_user_ids,
        started_at: schedule.next_run_at ?? new Date(),
        ended_at: null,
    }
}

/**
 * Site yang dipegang pemimpin SAAT INI (root: semua site aktif). Akses yang
 * dicabut sesudah jadwal dibuat ikut berlaku untuk pengingatnya.
 */
async function hostSites(hostUserId: number): Promise<number[] | 'all'> {
    const [roles, user] = await Promise.all([
        roleNamesOf(hostUserId),
        db.from('users').where('id', hostUserId).select('organization_id').first(),
    ])
    if (roles.includes('super_admin')) return 'all'
    const granted = await db
        .from('user_site_access')
        .where('user_id', hostUserId)
        .select('organization_id')
    const sites = new Set(granted.map((row) => Number(row.organization_id)))
    if (roles.includes('site_admin') && user?.organization_id) {
        sites.add(Number(user.organization_id))
    }
    return [...sites]
}

/**
 * Site yang diberi tahu lewat Telegram: site undangan, atau site peserta
 * pilihan -- selalu dibatasi ke site yang dipegang pemimpin, supaya judul
 * briefing tidak sampai ke chat site lain.
 */
async function sitesToNotify(schedule: ScheduleRow): Promise<number[]> {
    const own = await hostSites(schedule.host_user_id)
    let targets: number[]
    if (schedule.invited_user_ids.length) {
        const rows = await db
            .from('users')
            .whereIn('id', schedule.invited_user_ids)
            .whereNotNull('organization_id')
            .distinct('organization_id')
        targets = rows.map((row) => Number(row.organization_id))
    } else if (schedule.allowed_organization_ids.length) {
        targets = schedule.allowed_organization_ids
    } else if (own === 'all') {
        const sites = await db
            .from('organizations')
            .where('is_active', true)
            .whereNull('deleted_at')
            .select('id')
        return sites.map((row) => Number(row.id))
    } else {
        return own
    }
    return own === 'all' ? targets : targets.filter((id) => own.includes(id))
}

async function hostName(userId: number) {
    const row = await db.from('users').where('id', userId).select('name').first()
    return row?.name ?? 'pemimpin'
}

async function sendReminders(now: Date) {
    const soon = new Date(now.getTime() + REMINDER_MINUTES * MINUTE)
    const schedules: ScheduleRow[] = await db
        .from('briefing_schedules')
        .where('is_active', true)
        .whereNotNull('next_run_at')
        .where('next_run_at', '>', now)
        .where('next_run_at', '<=', soon)
        .where((query) => {
            query.whereNull('reminded_at').orWhereRaw('reminded_at <> next_run_at')
        })
    for (const schedule of schedules) {
        const at = schedule.next_run_at!
        const message = `📣 Briefing "${schedule.title}" mulai ${localTime(at)} (${Math.max(1, Math.round((at.getTime() - now.getTime()) / MINUTE))} menit lagi), dipimpin ${await hostName(schedule.host_user_id)}. Buka menu Briefing di dashboard untuk bergabung.`
        for (const organizationId of await sitesToNotify(schedule)) {
            await raiseAlert({
                organizationId,
                type: 'briefing_reminder',
                key: `briefing_reminder:${schedule.id}:${at.getTime()}:${organizationId}`,
                message,
                now,
            })
        }
        await db.from('briefing_schedules').where('id', schedule.id).update({ reminded_at: at })
    }
}

async function startDue(now: Date) {
    const schedules: ScheduleRow[] = await db
        .from('briefing_schedules')
        .where('is_active', true)
        .whereNotNull('next_run_at')
        .where('next_run_at', '<=', now)
    let started = 0
    for (const schedule of schedules) {
        const due = schedule.next_run_at!
        const open = await db
            .from('briefings')
            .where('schedule_id', schedule.id)
            .whereNull('ended_at')
            .first()
        if (!open && now.getTime() - due.getTime() <= LATE_START_MINUTES * MINUTE) {
            await db.table('briefings').insert({
                title: schedule.title,
                host_user_id: schedule.host_user_id,
                allowed_roles: JSON.stringify(schedule.allowed_roles),
                allowed_organization_ids: JSON.stringify(schedule.allowed_organization_ids),
                invited_user_ids: JSON.stringify(schedule.invited_user_ids),
                schedule_id: schedule.id,
                started_at: now,
                planned_end_at: new Date(now.getTime() + schedule.duration_minutes * MINUTE),
                created_at: now,
                updated_at: now,
            })
            started++
        }
        const next = nextRunAt(schedule, now)
        await db
            .from('briefing_schedules')
            .where('id', schedule.id)
            .update({ next_run_at: next, is_active: next !== null, updated_at: now })
    }
    return started
}

/** Tutup briefing untuk semua peserta. */
export async function finishBriefing(briefingId: number, now: Date = new Date()) {
    await db
        .from('briefings')
        .where('id', briefingId)
        .whereNull('ended_at')
        .update({ ended_at: now, updated_at: now })
    await closeBriefingRoom(briefingId)
}

async function endOverdue(now: Date) {
    const overdue = await db
        .from('briefings')
        .whereNull('ended_at')
        .whereNotNull('planned_end_at')
        .where('planned_end_at', '<=', now)
        .select('id', 'planned_end_at')
    let ended = 0
    for (const briefing of overdue) {
        const hardStop =
            now.getTime() - briefing.planned_end_at.getTime() >= HARD_STOP_MINUTES * MINUTE
        const inside = await db
            .from('briefing_attendances')
            .where('briefing_id', briefing.id)
            .where('last_seen_at', '>=', new Date(now.getTime() - PRESENCE_TIMEOUT_SECONDS * 1000))
            .first()
        if (inside && !hardStop) continue
        await finishBriefing(briefing.id, now)
        ended++
    }
    return ended
}

export async function runBriefingSchedules(now: Date = new Date()) {
    await sendReminders(now)
    const started = await startDue(now)
    const ended = await endOverdue(now)
    return { started, ended }
}

/** Peserta dianggap sudah keluar kalau detaknya berhenti selama ini. */
export const PRESENCE_TIMEOUT_SECONDS = 90

/**
 * Detak kehadiran dari dashboard peserta selama di ruang briefing. Detak
 * dalam PRESENCE_TIMEOUT_SECONDS memperpanjang kehadiran yang sama; lebih
 * lama = keluar-masuk, dicatat sebagai kehadiran baru.
 */
export async function pingBriefingPresence(
    briefingId: number,
    userId: number,
    now: Date = new Date()
) {
    const recent = await db
        .from('briefing_attendances')
        .where('briefing_id', briefingId)
        .where('user_id', userId)
        .where('last_seen_at', '>=', new Date(now.getTime() - PRESENCE_TIMEOUT_SECONDS * 1000))
        .orderBy('id', 'desc')
        .first()
    if (recent) {
        await db.from('briefing_attendances').where('id', recent.id).update({ last_seen_at: now })
        return
    }
    await db.table('briefing_attendances').insert({
        briefing_id: briefingId,
        user_id: userId,
        joined_at: now,
        last_seen_at: now,
    })
}
