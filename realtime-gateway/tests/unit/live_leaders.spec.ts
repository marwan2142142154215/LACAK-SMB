import { test } from '@japa/runner'
import type { AuthenticatedUser } from '#services/backend_api_client'
import { canBroadcast, canWatchLeaders, canWatchSite, liveRoom } from '#services/live_hub'

function user(roles: string[], permissions: string[] = ['live.watch']): AuthenticatedUser {
    return {
        id: 1,
        username: 'u',
        name: 'U',
        organizationId: 3,
        roles,
        permissions,
        accessibleOrganizationIds: [3],
    }
}

test.group('Live Kerja: ruang leader', () => {
    test('ruang leader hanya untuk admin & root -- bukan sesama leader atau staf', ({ assert }) => {
        assert.isFalse(canWatchLeaders(user(['leader'])))
        assert.isTrue(canWatchLeaders(user(['admin'])))
        assert.isTrue(canWatchLeaders(user(['super_admin'])))
        assert.isFalse(canWatchLeaders(user(['staff_viewer'], ['live.watch', 'live.broadcast'])))
    })

    test('leader boleh menyiarkan tanpa izin live.broadcast', ({ assert }) => {
        assert.isTrue(canBroadcast(user(['leader'])))
        assert.isTrue(canBroadcast(user(['staff_viewer'], ['live.broadcast'])))
        assert.isFalse(canBroadcast(user(['admin'])))
    })

    test('room status: site atau ruang leader', ({ assert }) => {
        assert.equal(liveRoom(3), 'live:3')
        assert.equal(liveRoom(null), 'live:leaders')
        assert.isTrue(canWatchSite(user(['leader']), 3))
        assert.isFalse(canWatchSite(user(['leader']), 4))
    })
})
