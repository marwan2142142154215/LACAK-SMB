import db from '@adonisjs/lucid/services/db'
import { localDate, isoWeekday } from '#services/LocalTime'
import { shiftsOfUsers, approvedLeaves, shiftBounds } from '#services/Attendance'
import { systemUserId, lockDevice, unlockDevice } from '#services/ScheduledDeviceLock'

/**
 * Kunci terjadwal "mengikuti shift PEMEGANG HP" (berbeda dari kunci per-site
 * "di luar jam kerja" di ScheduledDeviceLock).
 *
 * Tiap menit (dipanggil SchedulerRun), untuk tiap site yang menyalakan
 * `organizations.staff_shift_lock`:
 *  - Ambil HP yang SUDAH punya pemegang (devices.holder_user_id).
 *  - Tentukan status pemegangnya HARI INI: di dalam shift-nya, atau di luar.
 *    "Dalam shift" = bukan cuti disetujui + shift terjadwal hari ini + jam
 *    sekarang di dalam jendela shift (shift malam selesai keesokan harinya).
 *  - Di LUAR shift (atau cuti) -> kunci HP yang masih 'online' & belum dikunci
 *    jadwal. Di DALAM shift -> buka HP yang dikunci oleh jadwal ini.
 *  - Staf TANPA shift (belum ditautkan) -> HP-nya DIBIARKAN (tidak dikunci),
 *    supaya salah konfigurasi tidak menjebak HP terkunci.
 *  - HP TANPA pemegang -> bukan urusan service ini (diurus ScheduledDeviceLock
 *    per-site, yang mengecualikan HP berpemegang -> tidak ada rebutan device).
 *
 * Idempoten (rekonsiliasi tiap menit), bukan deteksi transisi. Zona waktu
 * mengikuti APP_TIMEZONE (LocalTime). Perintah lock/unlock hanya DICATAT di
 * device_commands (lewat helper ScheduledDeviceLock); pengiriman ke HP tetap
 * satu-satunya lewat CommandDispatcher gateway.
 */
export async function runStaffShiftDeviceLock(): Promise<{ locked: number; unlocked: number }> {
    const sysId = await systemUserId()
    // Tanpa akun system-automation tidak bisa mencatat issued_by dengan jujur -> no-op.
    if (!sysId) return { locked: 0, unlocked: 0 }

    const orgs = await db
        .from('organizations')
        .where('staff_shift_lock', true)
        .whereNull('deleted_at')
        .where('is_active', true)
        .select('id')
    if (!orgs.length) return { locked: 0, unlocked: 0 }

    const orgIds = orgs.map((org) => org.id)
    const devices = await db
        .from('devices')
        .whereIn('organization_id', orgIds)
        .whereNotNull('holder_user_id')
        .whereNull('deleted_at')
        .where('is_active', true)
        .select('id', 'status', 'holder_user_id', 'scheduled_locked')
    if (!devices.length) return { locked: 0, unlocked: 0 }

    const today = localDate()
    const weekday = isoWeekday(today)
    const nowMs = Date.now()

    const holderIds = [...new Set(devices.map((device) => Number(device.holder_user_id)))]
    const shifts = await shiftsOfUsers(holderIds)
    const leaves = await approvedLeaves(holderIds, today, today)
    const onLeave = new Set(leaves.map((leave) => leave.user_id))

    let locked = 0
    let unlocked = 0

    for (const device of devices) {
        const holderId = Number(device.holder_user_id)
        const shift = shifts.get(holderId)
        // Staf tanpa shift -> dibiarkan (tidak dikunci maupun dibuka).
        if (!shift) continue

        let inShift = false
        if (!onLeave.has(holderId) && shift.days.includes(weekday)) {
            const { start, end } = shiftBounds(shift, today)
            inShift = nowMs >= start.getTime() && nowMs < end.getTime()
        }

        if (!inShift) {
            // Di luar shift / sedang cuti -> kunci kalau masih online & belum dikunci jadwal.
            if (device.status === 'online' && !device.scheduled_locked) {
                await lockDevice(device.id, sysId, 'Jadwal staf: di luar jam shift pemegang')
                locked++
            }
        } else if (device.scheduled_locked) {
            // Dalam shift -> buka HP yang dikunci oleh jadwal ini.
            await unlockDevice(device.id, sysId, device.status === 'locked', 'Jadwal staf: shift mulai')
            unlocked++
        }
    }

    return { locked, unlocked }
}
