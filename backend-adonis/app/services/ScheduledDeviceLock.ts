import db from '@adonisjs/lucid/services/db'
import { localNow, localDate, isoWeekday } from '#services/LocalTime'

/**
 * Kunci terjadwal "di luar jam kerja".
 *
 * Tiap menit (dipanggil SchedulerRun), untuk tiap site yang mengaktifkan
 * `after_hours_lock`:
 *  - Ambil shift HARI INI (work_shifts.days berisi hari ISO ini).
 *  - Kalau site TIDAK punya shift hari ini -> DIBIARKAN (tidak dikunci/dibuka).
 *  - Di LUAR semua jendela jam kerja -> kunci HP yang masih 'online' & belum
 *    dikunci jadwal (status 'locked', scheduled_locked=true, perintah lock pending).
 *  - Di DALAM jam kerja -> buka HP yang dikunci oleh jadwal ini (scheduled_locked=true;
 *    perintah unlock pending, scheduled_locked=false). HP yang dikunci admin/geofence
 *    TIDAK disentuh (scheduled_locked-nya false).
 *
 * Idempoten (rekonsiliasi tiap menit), bukan deteksi transisi -- aman walau satu
 * putaran terlewat. Zona waktu mengikuti APP_TIMEZONE (LocalTime).
 *
 * Perintah 'lock'/'unlock' hanya DICATAT di device_commands (pending); pengiriman
 * ke HP tetap satu-satunya lewat CommandDispatcher gateway (sama seperti auto-lock
 * geofence), supaya tidak ada pengiriman dobel.
 */

let cachedSystemUserId: number | null = null

async function systemUserId(): Promise<number | null> {
    if (cachedSystemUserId !== null) return cachedSystemUserId
    const row = await db.from('users').where('username', 'system-automation').select('id').first()
    cachedSystemUserId = row?.id ?? null
    return cachedSystemUserId
}

/** "HH:mm" atau "HH:mm:ss" -> menit sejak tengah malam. */
function toMinutes(time: unknown): number | null {
    if (typeof time !== 'string') return null
    const m = /^(\d{1,2}):(\d{2})/.exec(time)
    if (!m) return null
    return Number(m[1]) * 60 + Number(m[2])
}

/** Apakah `now` di dalam [start, end). Mendukung shift lintas tengah malam (end <= start). */
function withinWindow(now: number, start: number, end: number): boolean {
    if (start === end) return false
    if (start < end) return now >= start && now < end
    return now >= start || now < end
}

function parseDays(raw: unknown): number[] {
    if (Array.isArray(raw)) return raw.map(Number)
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) return parsed.map(Number)
        } catch {
            // format tak dikenal -> anggap tak ada hari
        }
    }
    return []
}

export async function runScheduledDeviceLock(): Promise<{ locked: number; unlocked: number }> {
    const sysId = await systemUserId()
    // Tanpa akun system-automation tidak bisa mencatat issued_by dengan jujur -> jangan lakukan apa pun.
    if (!sysId) return { locked: 0, unlocked: 0 }

    const now = localNow()
    const today = localDate()
    const weekday = isoWeekday(today)
    const nowMinutes = now.hour * 60 + now.minute

    const orgs = await db
        .from('organizations')
        .where('after_hours_lock', true)
        .whereNull('deleted_at')
        .where('is_active', true)
        .select('id')

    let locked = 0
    let unlocked = 0

    for (const org of orgs) {
        const shifts = await db
            .from('work_shifts')
            .where('organization_id', org.id)
            .select('start_time', 'end_time', 'days')

        const todayShifts = shifts.filter((s) => parseDays(s.days).includes(weekday))

        // Hari tanpa shift = dibiarkan (tidak dikunci maupun dibuka).
        if (todayShifts.length === 0) continue

        const inWorkHours = todayShifts.some((s) => {
            const start = toMinutes(s.start_time)
            const end = toMinutes(s.end_time)
            return start !== null && end !== null && withinWindow(nowMinutes, start, end)
        })

        if (!inWorkHours) {
            const targets = await db
                .from('devices')
                .where('organization_id', org.id)
                .whereNull('deleted_at')
                .where('is_active', true)
                .where('status', 'online')
                .where('scheduled_locked', false)
                .select('id')
            for (const device of targets) {
                await lockDevice(device.id, sysId)
                locked++
            }
        } else {
            const targets = await db
                .from('devices')
                .where('organization_id', org.id)
                .whereNull('deleted_at')
                .where('scheduled_locked', true)
                .select('id', 'status')
            for (const device of targets) {
                await unlockDevice(device.id, sysId, device.status === 'locked')
                unlocked++
            }
        }
    }

    return { locked, unlocked }
}

async function lockDevice(deviceId: number, sysId: number) {
    const now = new Date()
    await db.transaction(async (trx) => {
        await trx.table('device_commands').insert({
            device_id: deviceId,
            command_type: 'lock',
            issued_by: sysId,
            issued_via: 'system_auto',
            status: 'pending',
            reason_note: 'Jadwal: di luar jam kerja',
            created_at: now,
            updated_at: now,
        })
        await trx
            .from('devices')
            .where('id', deviceId)
            .update({ status: 'locked', scheduled_locked: true, updated_by: sysId, updated_at: now })
    })
}

async function unlockDevice(deviceId: number, sysId: number, wasLocked: boolean) {
    const now = new Date()
    await db.transaction(async (trx) => {
        if (wasLocked) {
            await trx.table('device_commands').insert({
                device_id: deviceId,
                command_type: 'unlock',
                issued_by: sysId,
                issued_via: 'system_auto',
                status: 'pending',
                reason_note: 'Jadwal: jam kerja mulai',
                created_at: now,
                updated_at: now,
            })
        }
        await trx
            .from('devices')
            .where('id', deviceId)
            .update({
                ...(wasLocked ? { status: 'online' } : {}),
                scheduled_locked: false,
                updated_by: sysId,
                updated_at: now,
            })
    })
}
