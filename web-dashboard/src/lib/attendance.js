import dayjs from 'dayjs'

/** Status absensi dari server (app/services/attendance.ts) -> label & warna badge. */
export const ATTENDANCE_STATUS = {
    present: { label: 'Hadir', variant: 'success' },
    late: { label: 'Terlambat', variant: 'warning' },
    absent: { label: 'Tidak masuk', variant: 'danger' },
    not_started: { label: 'Belum mulai', variant: 'danger' },
    upcoming: { label: 'Belum waktunya', variant: 'neutral' },
    leave: { label: 'Izin', variant: 'accent' },
    off: { label: 'Libur', variant: 'neutral' },
}

export const LEAVE_LABELS = { izin: 'Izin', sakit: 'Sakit', cuti: 'Cuti' }

export const WEEKDAYS = [
    { value: 1, short: 'Sen', label: 'Senin' },
    { value: 2, short: 'Sel', label: 'Selasa' },
    { value: 3, short: 'Rab', label: 'Rabu' },
    { value: 4, short: 'Kam', label: 'Kamis' },
    { value: 5, short: 'Jum', label: 'Jumat' },
    { value: 6, short: 'Sab', label: 'Sabtu' },
    { value: 7, short: 'Min', label: 'Minggu' },
]

export function statusLabel(day) {
    if (day.status === 'leave') return LEAVE_LABELS[day.leave_type] ?? 'Izin'
    if (day.status === 'off' && !day.shift) return 'Tanpa shift'
    return ATTENDANCE_STATUS[day.status]?.label ?? day.status
}

export function describeDays(days) {
    const sorted = [...days].sort()
    if (sorted.join() === '1,2,3,4,5') return 'Senin–Jumat'
    if (sorted.join() === '1,2,3,4,5,6') return 'Senin–Sabtu'
    if (sorted.length === 7) return 'Setiap hari'
    return sorted.map((value) => WEEKDAYS.find((day) => day.value === value)?.short).join(', ')
}

export const clock = (iso) => (iso ? dayjs(iso).format('HH:mm') : '—')

export function minutesLabel(minutes) {
    if (!minutes) return '—'
    const hours = Math.floor(minutes / 60)
    return hours ? `${hours}j ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}
