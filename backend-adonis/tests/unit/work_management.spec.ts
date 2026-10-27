import { test } from '@japa/runner'
import { attendanceDay, type Shift } from '#services/attendance'
import { nextRunAt } from '#services/briefing_schedule'
import { dailyReportText } from '#services/work_alerts'
import type { PresenceEvent } from '#services/work_presence'

// Asia/Jakarta = UTC+7. 2026-10-26 hari Senin.
const SHIFT: Shift = {
    id: 1,
    organization_id: 3,
    name: 'Pagi',
    start_time: '08:00',
    end_time: '17:00',
    days: [1, 2, 3, 4, 5],
    late_tolerance_minutes: 10,
}
const USER = { id: 7, name: 'Staf A1', organization_id: 3 }
const wib = (date: string, time: string) => new Date(`${date}T${time}:00+07:00`)

function events(...items: Array<[string, string, PresenceEvent['status']]>): PresenceEvent[] {
    return items.map(([at, type, status], index) => ({
        id: index + 1,
        user_id: USER.id,
        user_name: null,
        organization_id: 3,
        type,
        status,
        occurred_at: wib('2026-10-26', at),
    }))
}

const day = (overrides: Partial<Parameters<typeof attendanceDay>[0]> = {}) =>
    attendanceDay({
        date: '2026-10-26',
        user: USER,
        shift: SHIFT,
        leave: null,
        events: [],
        before: null,
        now: wib('2026-10-26', '20:00'),
        ...overrides,
    })

test.group('Absensi: satu hari', () => {
    test('tepat waktu, jam kerja dihitung', ({ assert }) => {
        const result = day({
            events: events(['08:05', 'work_start', 'working'], ['17:00', 'work_end', 'offline']),
        })
        assert.equal(result.status, 'present')
        assert.equal(result.late_minutes, 0)
        assert.equal(result.work_seconds, (8 * 60 + 55) * 60)
        assert.equal(result.early_leave_minutes, 0)
    })

    test('terlambat lewat toleransi, pulang cepat, lembur', ({ assert }) => {
        const late = day({
            events: events(['08:25', 'work_start', 'working'], ['16:00', 'work_end', 'offline']),
        })
        assert.equal(late.status, 'late')
        assert.equal(late.late_minutes, 25)
        assert.equal(late.early_leave_minutes, 60)

        const overtime = day({
            events: events(['08:00', 'work_start', 'working'], ['18:15', 'work_end', 'offline']),
        })
        assert.equal(overtime.overtime_minutes, 75)
    })

    test('tidak masuk, belum mulai, izin, dan libur', ({ assert }) => {
        assert.equal(day().status, 'absent')
        assert.equal(day({ now: wib('2026-10-26', '09:00') }).status, 'not_started')
        assert.equal(day({ now: wib('2026-10-26', '07:00') }).status, 'upcoming')
        assert.equal(
            day({ leave: { user_id: 7, type: 'sakit', start_date: '2026-10-26', end_date: '2026-10-26' } })
                .status,
            'leave'
        )
        // Minggu: bukan hari kerja shift ini.
        assert.equal(day({ date: '2026-10-25', now: wib('2026-10-25', '20:00') }).status, 'off')
    })

    test('shift malam selesai keesokan harinya', ({ assert }) => {
        const night: Shift = { ...SHIFT, start_time: '22:00', end_time: '06:00', days: [1, 2, 3, 4, 5, 6, 7] }
        const result = day({
            shift: night,
            now: wib('2026-10-27', '12:00'),
            events: [
                ...events(['22:05', 'work_start', 'working']),
                {
                    id: 9,
                    user_id: 7,
                    user_name: null,
                    organization_id: 3,
                    type: 'work_end',
                    status: 'offline',
                    occurred_at: wib('2026-10-27', '06:00'),
                },
            ],
        })
        assert.equal(result.status, 'present')
        assert.equal(result.work_seconds, (7 * 60 + 55) * 60)
    })
})

test.group('Jadwal briefing: waktu berikutnya', () => {
    const base = { start_date: '2026-10-26', start_time: '08:00' }

    test('sekali, setiap hari, Senin–Jumat, setiap minggu', ({ assert }) => {
        assert.deepEqual(
            nextRunAt({ ...base, recurrence: 'once' }, wib('2026-10-26', '07:00')),
            wib('2026-10-26', '08:00')
        )
        assert.isNull(nextRunAt({ ...base, recurrence: 'once' }, wib('2026-10-26', '08:00')))
        assert.deepEqual(
            nextRunAt({ ...base, recurrence: 'daily' }, wib('2026-10-26', '09:00')),
            wib('2026-10-27', '08:00')
        )
        // Jumat sesudah jamnya -> Senin berikutnya.
        assert.deepEqual(
            nextRunAt({ ...base, recurrence: 'weekdays' }, wib('2026-10-30', '09:00')),
            wib('2026-11-02', '08:00')
        )
        assert.deepEqual(
            nextRunAt({ ...base, recurrence: 'weekly' }, wib('2026-10-26', '09:00')),
            wib('2026-11-02', '08:00')
        )
    })
})

test.group('Laporan harian', () => {
    test('berisi hadir, terlambat, dan tidak masuk', ({ assert }) => {
        const present = day({
            events: events(['08:30', 'work_start', 'working'], ['17:00', 'work_end', 'offline']),
        })
        const absent = { ...day(), user_id: 8, user_name: 'Staf A2' }
        const text = dailyReportText('Site Uji', '2026-10-26', [present, absent])
        assert.include(text, 'Hadir 1/2 terjadwal')
        assert.include(text, 'Terlambat 1')
        assert.include(text, '• Staf A1 (30 mnt)')
        assert.include(text, 'Tidak masuk:\n• Staf A2')
    })
})
