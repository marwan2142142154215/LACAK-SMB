import { test } from '@japa/runner'
import { broadcasterToken } from '#services/livekit'
import type { Access } from '#services/access'
import { authorizedOrganizationId, organizationFilter } from '#services/organization_scope'
import {
    statusOf,
    summarize,
    type PresenceEvent,
    type WorkSessionRow,
} from '#services/work_presence'

/**
 * Token dibuat LiveKitTokenIssuer::broadcasterToken(3, 42, 'Staf Ünïcode / A1')
 * di backend-api ASLI (api_key 'kunci-uji', secret 'r' x 40, ttl 600).
 */
const LARAVEL_LIVEKIT = {
    nbf: 1792903071,
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJrdW5jaS11amkiLCJzdWIiOiJ1c2VyLTQyIiwianRpIjoidXNlci00MiIsIm5hbWUiOiJTdGFmIMOcbsOvY29kZSAvIEExIiwibmJmIjoxNzkyOTAzMDcxLCJleHAiOjE3OTI5MDM2NzEsInZpZGVvIjp7InJvb20iOiJzaXRlLTMiLCJyb29tSm9pbiI6dHJ1ZSwiY2FuUHVibGlzaCI6dHJ1ZSwiY2FuUHVibGlzaFNvdXJjZXMiOlsiY2FtZXJhIiwibWljcm9waG9uZSIsInNjcmVlbl9zaGFyZSJdLCJjYW5TdWJzY3JpYmUiOnRydWUsImNhblB1Ymxpc2hEYXRhIjpmYWxzZSwiY2FuVXBkYXRlT3duTWV0YWRhdGEiOmZhbHNlfX0.QQqKoNduG-5VOy2_A9dwGJ-ltGsx6d5s0sBYnlZwiyo',
}

test.group('Live Kerja: token LiveKit', () => {
    test('token siaran sama persis dengan buatan Laravel', ({ assert }) => {
        const token = broadcasterToken(
            3,
            42,
            'Staf Ünïcode / A1',
            {},
            {
                url: 'wss://live.test',
                apiKey: 'kunci-uji',
                apiSecret: 'r'.repeat(40),
                tokenTtlSeconds: 600,
            },
            LARAVEL_LIVEKIT.nbf
        )

        assert.equal(token, LARAVEL_LIVEKIT.token)
    })
})

const NOW = new Date('2026-10-25T08:00:00Z')
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000)

function session(overrides: Partial<WorkSessionRow> = {}): WorkSessionRow {
    return {
        id: 1,
        user_id: 7,
        organization_id: 3,
        started_at: ago(3600),
        last_heartbeat_at: ago(10),
        ended_at: null,
        end_reason: null,
        disconnected_at: null,
        camera_active: true,
        screen_active: true,
        on_break: false,
        idle: false,
        ...overrides,
    }
}

test.group('Live Kerja: statusOf (padanan WorkPresence::statusOf)', () => {
    test('offline, disconnected, dan urutan prioritas status', ({ assert }) => {
        assert.equal(statusOf(null, NOW), 'offline')
        assert.equal(statusOf(session({ ended_at: ago(1) }), NOW), 'offline')
        assert.equal(statusOf(session({ last_heartbeat_at: ago(76) }), NOW), 'disconnected')
        assert.equal(statusOf(session({ on_break: true, camera_active: false }), NOW), 'break')
        assert.equal(
            statusOf(session({ camera_active: false, screen_active: false }), NOW),
            'alert'
        )
        assert.equal(
            statusOf(
                session({ camera_active: false, screen_active: false, started_at: ago(59) }),
                NOW
            ),
            'camera_off'
        )
        assert.equal(statusOf(session({ screen_active: false }), NOW), 'screen_off')
        assert.equal(statusOf(session({ idle: true }), NOW), 'idle')
        assert.equal(statusOf(session(), NOW), 'working')
    })
})

test.group('Live Kerja: ringkasan jam kerja (padanan WorkPresence::summarize)', () => {
    /** Kasus test_actual_work_hours_exclude_breaks di backend-api. */
    test('jam kerja aktual tidak menghitung istirahat', ({ assert }) => {
        const from = new Date('2026-10-25T01:00:00Z')
        const at = (minutes: number) => new Date(from.getTime() + minutes * 60_000)
        let id = 0
        const event = (
            minutes: number,
            type: string,
            status: PresenceEvent['status']
        ): PresenceEvent => ({
            id: ++id,
            user_id: 7,
            user_name: 'Staf A1',
            organization_id: 3,
            type,
            status,
            occurred_at: at(minutes),
        })

        const events = [
            event(5, 'work_start', 'camera_off'),
            event(5, 'camera_start', 'screen_off'),
            event(5, 'screen_start', 'working'),
            event(65, 'break_start', 'break'),
            event(95, 'break_end', 'working'),
            event(110, 'screen_stop', 'screen_off'),
            event(110, 'camera_stop', 'alert'),
            event(110, 'work_end', 'offline'),
        ]

        const [summary] = summarize(events, new Map(), from, at(24 * 60), at(200))

        assert.equal(summary.work_seconds, 75 * 60)
        assert.equal(summary.break_seconds, 30 * 60)
        assert.equal(summary.status, 'offline')
        assert.equal(summary.organization_id, 3)
    })

    test('status sebelum rentang dipakai sebagai awal hitungan', ({ assert }) => {
        const from = new Date('2026-10-25T00:00:00Z')
        const before: PresenceEvent = {
            id: 1,
            user_id: 9,
            user_name: 'Staf B1',
            organization_id: 4,
            type: 'screen_start',
            status: 'working',
            occurred_at: new Date('2026-10-24T23:00:00Z'),
        }

        const [summary] = summarize(
            [],
            new Map([[9, before]]),
            from,
            new Date('2026-10-26T00:00:00Z'),
            new Date('2026-10-25T02:00:00Z')
        )

        assert.equal(summary.work_seconds, 2 * 3600)
        assert.equal(summary.status, 'working')
    })
})

test.group('Cakupan site (padanan ResolvesOrganizationScope)', () => {
    const access = (
        roles: string[],
        organizationId: number | null,
        granted: number[] = []
    ): Access => ({
        userId: 1,
        organizationId,
        roles,
        permissions: [],
        grantedOrganizationIds: granted,
    })

    test('super_admin lintas site, admin/leader hanya site yang diberikan, staf site sendiri', ({
        assert,
    }) => {
        assert.equal(authorizedOrganizationId(access(['super_admin'], null), 5), 5)
        assert.equal(organizationFilter(access(['super_admin'], null)), 'all')

        const leader = access(['leader'], null, [2, 3])
        assert.equal(authorizedOrganizationId(leader, 3), 3)
        assert.isNull(authorizedOrganizationId(leader, 4))
        assert.isNull(authorizedOrganizationId(leader, null))
        assert.deepEqual(organizationFilter(leader), [2, 3])

        const staff = access(['staff_viewer'], 2)
        assert.equal(authorizedOrganizationId(staff, null), 2)
        assert.isNull(authorizedOrganizationId(staff, 3))
        assert.deepEqual(organizationFilter(staff), [2])
        assert.deepEqual(organizationFilter(access(['staff_viewer'], null)), [])
    })
})
