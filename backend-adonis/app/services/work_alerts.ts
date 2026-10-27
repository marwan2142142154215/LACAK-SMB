import db from '@adonisjs/lucid/services/db'
import {
    attendanceReport,
    shiftBounds,
    shiftRow,
    staffOfSites,
    type AttendanceDay,
} from '#services/attendance'
import { addDays, isoWeekday, localDate, localTime } from '#services/local_time'
import { sendToSite } from '#services/telegram'
import { FACE_LOG_MIN_SECONDS } from '#services/work_presence'

/**
 * Peringatan langsung & laporan kerja per site, dijalankan scheduler tiap
 * menit. Tiap pesan dicatat di work_alerts (dedupe_key unik) supaya tidak
 * terkirim dua kali, lalu dikirim ke chat Telegram site (kalau ada).
 */

export type AlertSettings = {
    organization_id: number
    alerts_enabled: boolean
    camera_off_minutes: number
    face_missing_minutes: number
    absent_alert: boolean
    daily_report: boolean
    weekly_report: boolean
    report_time: string
}

export const DEFAULT_SETTINGS: Omit<AlertSettings, 'organization_id'> = {
    alerts_enabled: true,
    camera_off_minutes: 10,
    face_missing_minutes: 10,
    absent_alert: true,
    daily_report: true,
    weekly_report: true,
    report_time: '17:00',
}

export const ALERT_TYPE_LABELS: Record<string, string> = {
    camera_off: 'Kamera mati',
    screen_off: 'Layar tidak dibagikan',
    face_missing: 'Wajah tidak terlihat',
    absent: 'Belum mulai kerja',
    daily_report: 'Laporan harian',
    weekly_report: 'Laporan mingguan',
    briefing_reminder: 'Pengingat briefing',
    leave_request: 'Pengajuan izin',
    announcement: 'Pengumuman',
}

export async function settingsFor(organizationId: number): Promise<AlertSettings> {
    const row = await db
        .from('work_alert_settings')
        .where('organization_id', organizationId)
        .first()
    return { ...DEFAULT_SETTINGS, ...(row ?? {}), organization_id: organizationId }
}

async function allSettings(): Promise<Map<number, AlertSettings>> {
    const rows = await db.from('work_alert_settings')
    return new Map(
        rows.map((row) => [Number(row.organization_id), { ...DEFAULT_SETTINGS, ...row }])
    )
}

/**
 * Catat lalu kirim. Pesan dengan dedupe_key yang sudah ada dilewati.
 * @returns true kalau pesan ini baru (belum pernah dicatat)
 */
export async function raiseAlert(alert: {
    organizationId: number | null
    userId?: number | null
    type: string
    key: string
    message: string
    now?: Date
    /** false = hanya dicatat; pengirim menggabungkannya sendiri ke satu pesan. */
    send?: boolean
}): Promise<boolean> {
    const inserted = await db
        .table('work_alerts')
        .insert({
            organization_id: alert.organizationId,
            user_id: alert.userId ?? null,
            type: alert.type,
            dedupe_key: alert.key,
            message: alert.message,
            sent_telegram: false,
            created_at: alert.now ?? new Date(),
        })
        .onConflict('dedupe_key')
        .ignore()
        .returning('id')
    if (!inserted.length) return false
    if (alert.send === false) return true
    if (alert.organizationId !== null && (await sendToSite(alert.organizationId, alert.message))) {
        await db.from('work_alerts').where('id', inserted[0].id).update({ sent_telegram: true })
    }
    return true
}

export function formatDuration(seconds: number): string {
    const minutes = Math.round(seconds / 60)
    const hours = Math.floor(minutes / 60)
    return hours ? `${hours}j ${minutes % 60}m` : `${minutes}m`
}

const MINUTE = 60_000
/**
 * "Belum Mulai kerja" hanya diperingatkan selama ini setelah batas terlambat
 * -- staf yang baru dipasang shift (atau server baru menyala) siang hari
 * tidak memicu peringatan untuk shift yang sudah lama berjalan.
 */
const ABSENT_ALERT_WINDOW_MINUTES = 120

/** Kamera mati, layar tidak dibagikan, wajah tidak terlihat -- terlalu lama. */
async function sessionAlerts(settings: Map<number, AlertSettings>, now: Date) {
    const sessions = await db
        .from('work_sessions')
        .join('users', 'users.id', 'work_sessions.user_id')
        .leftJoin('organizations', 'organizations.id', 'work_sessions.organization_id')
        .whereNull('work_sessions.ended_at')
        .whereNotNull('work_sessions.organization_id')
        .where('work_sessions.on_break', false)
        .where((query) => {
            query
                .where('work_sessions.camera_active', false)
                .orWhere('work_sessions.screen_active', false)
                .orWhere('work_sessions.face_missing', true)
        })
        .select('work_sessions.*', 'users.name as user_name', 'organizations.name as site_name')
    let raised = 0
    for (const session of sessions) {
        const config =
            settings.get(Number(session.organization_id)) ??
            ({ ...DEFAULT_SETTINGS } as AlertSettings)
        if (!config.alerts_enabled) continue

        const checks = [
            {
                when: !session.camera_active,
                event: 'camera_stop',
                type: 'camera_off',
                minutes: config.camera_off_minutes,
                text: session.screen_active ? 'kameranya mati' : 'kamera & layarnya mati',
            },
            {
                // Kamera & layar sama-sama mati: cukup satu pesan (kamera).
                when: !session.screen_active && session.camera_active,
                event: 'screen_stop',
                type: 'screen_off',
                minutes: config.camera_off_minutes,
                text: 'layarnya tidak dibagikan',
            },
            {
                when: session.face_missing,
                event: 'face_lost',
                type: 'face_missing',
                minutes: Math.max(config.face_missing_minutes, FACE_LOG_MIN_SECONDS / 60),
                text: 'wajahnya tidak terlihat di kamera',
            },
        ]
        for (const check of checks) {
            if (!check.when) continue
            const event = await db
                .from('work_session_events')
                .where('work_session_id', session.id)
                .where('type', check.event)
                .orderBy('id', 'desc')
                .first()
            // Belum ada kejadiannya (kamera belum pernah menyala): hitung dari awal sesi.
            const since: Date = event?.occurred_at ?? session.started_at
            const minutes = Math.floor((now.getTime() - since.getTime()) / MINUTE)
            if (minutes < check.minutes) continue
            const created = await raiseAlert({
                organizationId: Number(session.organization_id),
                userId: Number(session.user_id),
                type: check.type,
                key: `${check.type}:${session.id}:${event?.id ?? 'start'}`,
                message: `⚠️ ${session.user_name} (${session.site_name}) ${check.text} sejak ${localTime(since)} -- sudah ${minutes} menit.`,
                now,
            })
            if (created) raised++
        }
    }
    return raised
}

/** Staf yang belum Mulai kerja padahal shift-nya sudah lewat batas terlambat. */
async function absentAlerts(settings: Map<number, AlertSettings>, now: Date) {
    const today = localDate(now)
    const weekday = isoWeekday(today)
    const rows = await db
        .from('staff_shifts')
        .join('work_shifts', 'work_shifts.id', 'staff_shifts.work_shift_id')
        .join('users', 'users.id', 'staff_shifts.user_id')
        .leftJoin('organizations', 'organizations.id', 'users.organization_id')
        .whereNull('users.deleted_at')
        .where('users.is_active', true)
        .whereNotNull('users.organization_id')
        .select(
            'staff_shifts.user_id',
            'users.name as user_name',
            'users.organization_id as user_organization_id',
            'organizations.name as site_name',
            'work_shifts.*'
        )

    const due = rows.filter((row) => {
        const config = settings.get(Number(row.user_organization_id)) ?? DEFAULT_SETTINGS
        if (!config.alerts_enabled || !config.absent_alert) return false
        const shift = shiftRow(row)
        if (!shift.days.includes(weekday)) return false
        const { start, end } = shiftBounds(shift, today)
        const lateAfter = start.getTime() + shift.late_tolerance_minutes * MINUTE
        const until = Math.min(end.getTime(), lateAfter + ABSENT_ALERT_WINDOW_MINUTES * MINUTE)
        return now.getTime() >= lateAfter && now.getTime() < until
    })
    if (!due.length) return 0

    const alertedRows = await db
        .from('work_alerts')
        .whereIn(
            'dedupe_key',
            due.map((row) => `absent:${row.user_id}:${today}`)
        )
        .select('dedupe_key')
    const alerted = new Set(alertedRows.map((row) => row.dedupe_key))
    const pending = due.filter((row) => !alerted.has(`absent:${row.user_id}:${today}`))
    if (!pending.length) return 0

    const days = await attendanceReport(
        pending.map((row) => ({
            id: Number(row.user_id),
            name: row.user_name,
            organization_id: Number(row.user_organization_id),
        })),
        today,
        today,
        now
    )
    // Dicatat per staf (sekali sehari), dikirim sebagai satu pesan per site.
    const bySite = new Map<number, { siteName: string; lines: string[] }>()
    for (const day of days) {
        if (day.status !== 'not_started' || day.organization_id === null) continue
        const row = pending.find((candidate) => Number(candidate.user_id) === day.user_id)!
        const created = await raiseAlert({
            organizationId: day.organization_id,
            userId: day.user_id,
            type: 'absent',
            key: `absent:${day.user_id}:${today}`,
            message: `⏰ ${day.user_name} (${row.site_name}) belum Mulai kerja. Shift ${row.name} mulai ${row.start_time}.`,
            now,
            send: false,
        })
        if (!created) continue
        const site = bySite.get(day.organization_id) ?? {
            siteName: row.site_name,
            lines: [] as string[],
        }
        site.lines.push(`• ${day.user_name} -- shift ${row.name} ${row.start_time}`)
        bySite.set(day.organization_id, site)
    }

    let raised = 0
    for (const [organizationId, site] of bySite) {
        raised += site.lines.length
        const shown = site.lines.slice(0, 30)
        if (site.lines.length > shown.length) {
            shown.push(`• …dan ${site.lines.length - shown.length} lainnya`)
        }
        const text = [
            `⏰ ${site.lines.length} staf ${site.siteName} belum Mulai kerja:`,
            ...shown,
        ].join('\n')
        if (await sendToSite(organizationId, text)) {
            await db
                .from('work_alerts')
                .where('type', 'absent')
                .where('organization_id', organizationId)
                .where('created_at', now)
                .update({ sent_telegram: true })
        }
    }
    return raised
}

const names = (days: AttendanceDay[], detail?: (day: AttendanceDay) => string, limit = 15) => {
    const lines = days
        .slice(0, limit)
        .map((day) => `• ${day.user_name}${detail ? ` (${detail(day)})` : ''}`)
    if (days.length > limit) lines.push(`• …dan ${days.length - limit} lainnya`)
    return lines
}

/** Isi laporan harian satu site. */
export function dailyReportText(siteName: string, date: string, days: AttendanceDay[]): string {
    const scheduled = days.filter((day) => day.scheduled)
    const present = days.filter((day) => ['present', 'late'].includes(day.status))
    const late = days.filter((day) => day.status === 'late')
    const absent = days.filter((day) => ['absent', 'not_started'].includes(day.status))
    const leave = days.filter((day) => day.status === 'leave')
    const totalWork = days.reduce((sum, day) => sum + day.work_seconds, 0)
    const faceLost = days.reduce((sum, day) => sum + day.face_lost_count, 0)

    const lines = [
        `📊 Laporan kerja ${siteName} -- ${date}`,
        `Hadir ${present.length}${scheduled.length ? `/${scheduled.length} terjadwal` : ''} · Terlambat ${late.length} · Tidak masuk ${absent.length} · Izin/cuti ${leave.length}`,
        `Total jam kerja ${formatDuration(totalWork)} · Wajah hilang ≥5 menit: ${faceLost} kali`,
    ]
    if (late.length)
        lines.push('', 'Terlambat:', ...names(late, (day) => `${day.late_minutes} mnt`))
    if (absent.length) lines.push('', 'Tidak masuk:', ...names(absent))
    if (leave.length)
        lines.push('', 'Izin/cuti:', ...names(leave, (day) => day.leave_type ?? 'izin'))
    const busiest = [...present].sort((a, b) => b.work_seconds - a.work_seconds)
    if (busiest.length) {
        lines.push(
            '',
            'Jam kerja:',
            ...names(busiest, (day) => formatDuration(day.work_seconds), 10)
        )
    }
    return lines.join('\n')
}

/** Isi laporan mingguan satu site (7 hari). */
export function weeklyReportText(
    siteName: string,
    from: string,
    to: string,
    days: AttendanceDay[]
): string {
    const byUser = new Map<
        number,
        {
            name: string | null
            work: number
            late: number
            absent: number
            leave: number
            present: number
        }
    >()
    for (const day of days) {
        const totals = byUser.get(day.user_id) ?? {
            name: day.user_name,
            work: 0,
            late: 0,
            absent: 0,
            leave: 0,
            present: 0,
        }
        totals.work += day.work_seconds
        if (day.status === 'late') totals.late++
        if (day.status === 'absent') totals.absent++
        if (day.status === 'leave') totals.leave++
        if (['present', 'late'].includes(day.status)) totals.present++
        byUser.set(day.user_id, totals)
    }
    const staff = [...byUser.values()]
    const totalWork = staff.reduce((sum, member) => sum + member.work, 0)
    const lines = [
        `🗓️ Laporan mingguan ${siteName} -- ${from} s/d ${to}`,
        `Total jam kerja ${formatDuration(totalWork)} · Terlambat ${staff.reduce((s, m) => s + m.late, 0)} kali · Tidak masuk ${staff.reduce((s, m) => s + m.absent, 0)} hari · Izin/cuti ${staff.reduce((s, m) => s + m.leave, 0)} hari`,
    ]
    const ranked = staff.filter((member) => member.work > 0).sort((a, b) => b.work - a.work)
    if (ranked.length) {
        lines.push(
            '',
            'Jam kerja terbanyak:',
            ...ranked
                .slice(0, 10)
                .map((m) => `• ${m.name} -- ${formatDuration(m.work)} (${m.present} hari)`)
        )
    }
    const flagged = staff.filter((member) => member.late || member.absent)
    if (flagged.length) {
        lines.push(
            '',
            'Perlu perhatian:',
            ...flagged
                .sort((a, b) => b.absent + b.late - (a.absent + a.late))
                .slice(0, 15)
                .map((m) => `• ${m.name} -- terlambat ${m.late}x, tidak masuk ${m.absent} hari`)
        )
    }
    return lines.join('\n')
}

/** Laporan harian (tiap hari) & mingguan (Senin, untuk minggu lalu) per site. */
async function reports(settings: Map<number, AlertSettings>, now: Date) {
    const today = localDate(now)
    const time = localTime(now)
    const sites = await db
        .from('organizations')
        .where('is_active', true)
        .whereNull('deleted_at')
        .select('id', 'name')
    let sent = 0
    for (const site of sites) {
        const config = settings.get(Number(site.id)) ?? DEFAULT_SETTINGS
        if (time < config.report_time) continue

        const jobs: Array<{ type: string; key: string; from: string; to: string }> = []
        if (config.daily_report) {
            jobs.push({
                type: 'daily_report',
                key: `daily_report:${site.id}:${today}`,
                from: today,
                to: today,
            })
        }
        if (config.weekly_report && isoWeekday(today) === 1) {
            jobs.push({
                type: 'weekly_report',
                key: `weekly_report:${site.id}:${today}`,
                from: addDays(today, -7),
                to: addDays(today, -1),
            })
        }
        for (const job of jobs) {
            const exists = await db.from('work_alerts').where('dedupe_key', job.key).first()
            if (exists) continue
            const staff = await staffOfSites([Number(site.id)])
            if (!staff.length) continue
            const days = await attendanceReport(staff, job.from, job.to, now)
            const message =
                job.type === 'daily_report'
                    ? dailyReportText(site.name, job.from, days)
                    : weeklyReportText(site.name, job.from, job.to, days)
            if (
                await raiseAlert({
                    organizationId: Number(site.id),
                    type: job.type,
                    key: job.key,
                    message,
                    now,
                })
            )
                sent++
        }
    }
    return sent
}

/** Satu putaran scheduler. */
export async function runWorkAlerts(now: Date = new Date()) {
    const settings = await allSettings()
    const alerts = (await sessionAlerts(settings, now)) + (await absentAlerts(settings, now))
    const reportCount = await reports(settings, now)
    return { alerts, reports: reportCount }
}
