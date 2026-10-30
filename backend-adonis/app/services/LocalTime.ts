import { DateTime } from 'luxon'
import env from '#start/env'

/**
 * Waktu lokal kantor untuk jam shift, jadwal briefing, dan laporan kerja.
 * Proses berjalan dalam UTC (TZ=UTC); jam "HH:mm" yang diketik pengguna
 * dibaca dalam APP_TIMEZONE (default Asia/Jakarta).
 */
export const zone = () => env.get('APP_TIMEZONE') || 'Asia/Jakarta'

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function localNow(now: Date = new Date()): DateTime {
    return DateTime.fromJSDate(now, { zone: zone() })
}

/** Tanggal lokal "yyyy-MM-dd" dari sebuah waktu. */
export function localDate(at: Date = new Date()): string {
    return localNow(at).toISODate()!
}

/** Tanggal "yyyy-MM-dd" + jam "HH:mm" waktu lokal -> waktu sebenarnya. */
export function atLocal(date: string, time: string): Date {
    return DateTime.fromISO(`${date}T${time}`, { zone: zone() }).toJSDate()
}

/** Awal hari lokal tanggal ini. */
export function startOfLocalDay(date: string): Date {
    return DateTime.fromISO(date, { zone: zone() }).startOf('day').toJSDate()
}

/** Hari ISO (1 = Senin ... 7 = Minggu) untuk tanggal lokal ini. */
export function isoWeekday(date: string): number {
    return DateTime.fromISO(date, { zone: zone() }).weekday
}

export function addDays(date: string, days: number): string {
    return DateTime.fromISO(date, { zone: zone() }).plus({ days }).toISODate()!
}

/** Semua tanggal dari `from` sampai `to` (keduanya ikut). */
export function datesBetween(from: string, to: string): string[] {
    const dates: string[] = []
    for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date)
    return dates
}

/** "HH:mm" waktu lokal dari sebuah waktu. */
export function localTime(at: Date): string {
    return localNow(at).toFormat('HH:mm')
}

/** Kolom DATE dari Postgres bisa berupa Date (tengah malam UTC) atau string. */
export function dateColumn(value: Date | string): string {
    if (typeof value === 'string') return value.slice(0, 10)
    return DateTime.fromJSDate(value, { zone: 'utc' }).toISODate()!
}
