import { test } from '@japa/runner'
import type { Access } from '#services/access'
import { seesOnlySelf } from '#services/access'
import { broadcasterToken } from '#services/livekit'

const CONFIG = {
    url: 'wss://live.test',
    apiKey: 'kunci-uji',
    apiSecret: 'r'.repeat(40),
    tokenTtlSeconds: 600,
}

function access(roles: string[]): Access {
    return {
        userId: 7,
        organizationId: 3,
        roles,
        permissions: ['live.watch', 'live.broadcast'],
        grantedOrganizationIds: [],
    }
}

function grantsOf(token: string) {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).video
}

test.group('Live Kerja: staf hanya melihat dirinya sendiri', () => {
    test('hanya staf biasa yang dibatasi', ({ assert }) => {
        assert.isTrue(seesOnlySelf(access(['staff_viewer'])))
        assert.isFalse(seesOnlySelf(access(['site_admin'])))
        assert.isFalse(seesOnlySelf(access(['leader'])))
        assert.isFalse(seesOnlySelf(access(['staff_viewer', 'admin'])))
    })

    test('token siaran staf tidak bisa menonton rekan di room site', ({ assert }) => {
        const staff = broadcasterToken(3, 7, 'Staf', { canSubscribe: false }, CONFIG)
        assert.isFalse(grantsOf(staff).canSubscribe)
        assert.isTrue(grantsOf(staff).canPublish)
        assert.isTrue(grantsOf(broadcasterToken(3, 8, 'Admin site', {}, CONFIG)).canSubscribe)
        assert.isFalse(grantsOf(broadcasterToken(null, 9, 'Leader', {}, CONFIG)).canSubscribe)
    })
})
