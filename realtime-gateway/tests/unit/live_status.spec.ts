import { test } from '@japa/runner'
import { parseReportedState, statusOf, type WorkSessionRow } from '#services/live_status'

/** Kasus yang sama dengan WorkPresenceTest di backend-api -- aturannya harus identik. */
const NOW = new Date('2026-10-25T08:00:00Z')
const secondsAgo = (seconds: number) => new Date(NOW.getTime() - seconds * 1000)

function session(overrides: Partial<WorkSessionRow> = {}): WorkSessionRow {
    return {
        id: 1,
        user_id: 7,
        organization_id: 3,
        started_at: secondsAgo(3600),
        last_heartbeat_at: secondsAgo(10),
        ended_at: null,
        disconnected_at: null,
        camera_active: true,
        screen_active: true,
        on_break: false,
        idle: false,
        ...overrides,
    }
}

test.group('Live Kerja: statusOf (padanan WorkPresence::statusOf)', () => {
    test('tanpa sesi atau sesi selesai = offline', ({ assert }) => {
        assert.equal(statusOf(null, NOW), 'offline')
        assert.equal(statusOf(session({ ended_at: secondsAgo(5) }), NOW), 'offline')
    })

    test('heartbeat lebih dari 75 detik lalu atau ditandai terputus = disconnected', ({
        assert,
    }) => {
        assert.equal(statusOf(session({ last_heartbeat_at: secondsAgo(75) }), NOW), 'working')
        assert.equal(statusOf(session({ last_heartbeat_at: secondsAgo(76) }), NOW), 'disconnected')
        assert.equal(statusOf(session({ disconnected_at: secondsAgo(1) }), NOW), 'disconnected')
    })

    test('urutan prioritas: break > alert > camera_off > screen_off > idle > working', ({
        assert,
    }) => {
        assert.equal(
            statusOf(session({ on_break: true, camera_active: false, screen_active: false }), NOW),
            'break'
        )
        assert.equal(
            statusOf(session({ camera_active: false, screen_active: false }), NOW),
            'alert'
        )
        assert.equal(statusOf(session({ camera_active: false, idle: true }), NOW), 'camera_off')
        assert.equal(statusOf(session({ screen_active: false, idle: true }), NOW), 'screen_off')
        assert.equal(statusOf(session({ idle: true }), NOW), 'idle')
        assert.equal(statusOf(session(), NOW), 'working')
    })

    test('kamera & layar mati di menit pertama kerja belum alert', ({ assert }) => {
        const justStarted = { camera_active: false, screen_active: false }

        assert.equal(
            statusOf(session({ ...justStarted, started_at: secondsAgo(59) }), NOW),
            'camera_off'
        )
        assert.equal(
            statusOf(session({ ...justStarted, started_at: secondsAgo(61) }), NOW),
            'alert'
        )
    })
})

test.group('Live Kerja: laporan status dari staf', () => {
    test('hanya kolom status bertipe boolean yang diterima', ({ assert }) => {
        assert.deepEqual(
            parseReportedState({
                camera_active: true,
                screen_active: 'ya',
                on_break: false,
                idle: null,
                ended_at: 'curang',
            }),
            { camera_active: true, on_break: false }
        )
        assert.deepEqual(parseReportedState(null), {})
    })
})
