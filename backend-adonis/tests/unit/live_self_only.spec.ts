import { test } from '@japa/runner'
import type { Access } from '#services/Access'
import { canWatchCentral, canWatchRole, seesOnlySelf } from '#services/Access'
import { broadcasterToken } from '#services/Livekit'

const CONFIG = {
    url: 'wss://live.test',
    apiKey: 'kunci-uji',
    apiSecret: 'r'.repeat(40),
    tokenTtlSeconds: 600,
}

function access(permissions: string[]): Access {
    return {
        userId: 7,
        organizationId: 3,
        roles: [],
        permissions,
        grantedOrganizationIds: [],
    }
}

function grantsOf(token: string) {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).video
}

test.group('Live Kerja: staf hanya melihat dirinya sendiri', () => {
    test('hanya yang tak punya izin live.roster yang dibatasi', ({ assert }) => {
        assert.isTrue(seesOnlySelf(access(['live.watch', 'live.broadcast'])))
        assert.isFalse(seesOnlySelf(access(['live.watch', 'live.roster'])))
    })

    test('token siaran staf tidak bisa menonton rekan di room site', ({ assert }) => {
        const site = { organizationId: 3, role: 'staff_viewer' }
        const staff = broadcasterToken(site, 7, 'Staf', { canSubscribe: false }, CONFIG)
        assert.isFalse(grantsOf(staff).canSubscribe)
        assert.isTrue(grantsOf(staff).canPublish)
        assert.isTrue(grantsOf(broadcasterToken(site, 8, 'Admin site', {}, CONFIG)).canSubscribe)
        const central = { organizationId: null, role: 'leader' }
        assert.isFalse(grantsOf(broadcasterToken(central, 9, 'Leader', {}, CONFIG)).canSubscribe)
    })
})

test.group('Live Kerja: hak tonton per peran', () => {
    const viewer = (watchRoles: string[] | null, permissions: string[] = []): Access => ({
        userId: 1,
        organizationId: null,
        roles: [],
        permissions,
        grantedOrganizationIds: [],
        watchRoles,
    })

    test('null = semua peran; daftar = hanya peran itu; kosong = tidak ada', ({ assert }) => {
        assert.isTrue(canWatchRole(viewer(null), 'leader'))
        assert.isTrue(canWatchRole(viewer(['staff_viewer']), 'staff_viewer'))
        assert.isFalse(canWatchRole(viewer(['staff_viewer']), 'leader'))
        assert.isFalse(canWatchRole(viewer([]), 'staff_viewer'))
    })

    test('Ruang pusat hanya untuk pemegang live.watch-central', ({ assert }) => {
        assert.isTrue(canWatchCentral(viewer(null, ['live.watch-central'])))
        assert.isFalse(canWatchCentral(viewer(null, ['live.watch', 'live.roster'])))
    })
})
