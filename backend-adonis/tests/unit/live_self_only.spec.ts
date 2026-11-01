import { test } from '@japa/runner'
import type { Access } from '#services/Access'
import { seesOnlySelf } from '#services/Access'
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
        const staff = broadcasterToken(3, 7, 'Staf', { canSubscribe: false }, CONFIG)
        assert.isFalse(grantsOf(staff).canSubscribe)
        assert.isTrue(grantsOf(staff).canPublish)
        assert.isTrue(grantsOf(broadcasterToken(3, 8, 'Admin site', {}, CONFIG)).canSubscribe)
        assert.isFalse(grantsOf(broadcasterToken(null, 9, 'Leader', {}, CONFIG)).canSubscribe)
    })
})
