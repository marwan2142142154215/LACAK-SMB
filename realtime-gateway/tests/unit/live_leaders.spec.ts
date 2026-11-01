import { test } from '@japa/runner'
import type { AuthenticatedUser } from '#services/BackendApiClient'
import {
    canBroadcast,
    canWatchCentral,
    canWatchRole,
    canWatchRoom,
    canWatchSite,
    liveRoom,
    parseLiveRoom,
    seesOnlySelf,
} from '#services/LiveHub'

function user(
    roles: string[],
    permissions: string[] = ['live.watch', 'live.roster'],
    watchRoles: string[] | null = null
): AuthenticatedUser {
    return {
        id: 1,
        username: 'u',
        name: 'U',
        organizationId: 3,
        roles,
        permissions,
        accessibleOrganizationIds: [3],
        watchRoles,
        siteScope: roles.includes('super_admin')
            ? 'all'
            : roles.some((role) => ['admin', 'leader'].includes(role))
              ? 'granted'
              : 'own',
    }
}

test.group('Live Kerja: Ruang pusat', () => {
    test('Ruang pusat hanya untuk pemegang live.watch-central', ({ assert }) => {
        const admin = user(['admin'], ['live.watch', 'live.roster', 'live.watch-central'])
        assert.isTrue(canWatchCentral(admin))
        assert.isTrue(canWatchRoom(admin, { organizationId: null, role: 'leader' }))
        assert.isFalse(canWatchCentral(user(['leader'])))
        assert.isFalse(canWatchRoom(user(['leader']), { organizationId: null, role: 'leader' }))
    })

    test('semua peran bisa siaran asal punya izin live.broadcast', ({ assert }) => {
        assert.isTrue(canBroadcast(user(['leader'], ['live.broadcast'])))
        assert.isTrue(canBroadcast(user(['operator'], ['live.broadcast'])))
        assert.isFalse(canBroadcast(user(['leader'])))
        assert.isFalse(canBroadcast(user(['admin'])))
    })

    test('room status: site + peran, atau pusat + peran', ({ assert }) => {
        assert.equal(liveRoom(3, 'staff_viewer'), 'live:3:staff_viewer')
        assert.equal(liveRoom(null, 'leader'), 'live:pusat:leader')
        assert.deepEqual(parseLiveRoom('live:3:staff_viewer'), {
            organizationId: 3,
            role: 'staff_viewer',
        })
        assert.deepEqual(parseLiveRoom('live:pusat:leader'), {
            organizationId: null,
            role: 'leader',
        })
        assert.isNull(parseLiveRoom('live:3'))
        assert.isTrue(canWatchSite(user(['leader']), 3))
        assert.isFalse(canWatchSite(user(['leader']), 4))
    })
})

test.group('Live Kerja: hak tonton per peran', () => {
    test('null = semua peran; daftar = hanya peran itu', ({ assert }) => {
        assert.isTrue(canWatchRole(user(['admin']), 'leader'))
        const pengawas = user(['pengawas'], ['live.watch', 'live.roster'], ['operator'])
        assert.isTrue(canWatchRole(pengawas, 'operator'))
        assert.isFalse(canWatchRole(pengawas, 'staff_viewer'))
        assert.isTrue(canWatchRoom(pengawas, { organizationId: 3, role: 'operator' }))
        assert.isFalse(canWatchRoom(pengawas, { organizationId: 3, role: 'staff_viewer' }))
    })
})

test.group('Live Kerja: cakupan site peran buatan sendiri', () => {
    test('peran buatan ber-cakupan "Semua site" (mis. auditor) menonton semua site', ({
        assert,
    }) => {
        const auditor = { ...user(['auditor']), organizationId: null, siteScope: 'all' as const }
        assert.isTrue(canWatchSite(auditor, 3))
        assert.isTrue(canWatchSite(auditor, 99))
        const granted = { ...user(['pengawas']), siteScope: 'granted' as const }
        assert.isTrue(canWatchSite(granted, 3))
        assert.isFalse(canWatchSite(granted, 4))
    })
})

test.group('Live Kerja: staf hanya melihat dirinya sendiri', () => {
    test('staf biasa tidak ikut room status site-nya', ({ assert }) => {
        const staff = user(['staff_viewer'], ['live.watch', 'live.broadcast'])
        assert.isTrue(seesOnlySelf(staff))
        assert.isFalse(canWatchSite(staff, 3))
        assert.isFalse(canWatchRoom(staff, { organizationId: 3, role: 'staff_viewer' }))
        assert.isTrue(canBroadcast(staff))
    })

    test('pengawas tetap melihat site-nya', ({ assert }) => {
        assert.isFalse(seesOnlySelf(user(['site_admin'])))
        assert.isTrue(canWatchSite(user(['site_admin']), 3))
        assert.isFalse(seesOnlySelf(user(['staff_viewer', 'leader'])))
    })
})
