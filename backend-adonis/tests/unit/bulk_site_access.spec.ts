import { test } from '@japa/runner'
import { MAX_BULK_SITES, MAX_BULK_USERS, parseBulkSiteAccess } from '#services/BulkSiteAccess'

test.group('Akses site massal: validasi input', () => {
    test('input lengkap diterima, id dirapikan dan dibuat unik', ({ assert }) => {
        const result = parseBulkSiteAccess({
            user_ids: [1, '2', 2],
            organization_ids: ['5', 6, 6],
            mode: 'replace',
        })
        assert.isTrue(result.ok)
        if (result.ok) {
            assert.deepEqual(result.data, {
                userIds: [1, 2],
                organizationIds: [5, 6],
                mode: 'replace',
            })
        }
    })

    test('mode bawaan add; all_sites menggantikan daftar site', ({ assert }) => {
        const result = parseBulkSiteAccess({ user_ids: [3], all_sites: true })
        assert.isTrue(result.ok)
        if (result.ok) {
            assert.equal(result.data.mode, 'add')
            assert.equal(result.data.organizationIds, 'all')
        }
    })

    test('all_sites menerima true, 1, "1", dan "true" saja', ({ assert }) => {
        for (const value of [true, 1, '1', 'true']) {
            assert.isTrue(parseBulkSiteAccess({ user_ids: [1], all_sites: value }).ok)
        }
        for (const value of [false, 0, '0', 'yes', null, 'false']) {
            assert.isFalse(parseBulkSiteAccess({ user_ids: [1], all_sites: value }).ok)
        }
    })

    test('user kosong, bukan angka, atau terlalu banyak ditolak', ({ assert }) => {
        for (const userIds of [undefined, [], 'abc', [0], [-1], ['x'], [1.5]]) {
            const result = parseBulkSiteAccess({ user_ids: userIds, all_sites: true })
            assert.isFalse(result.ok)
            if (!result.ok) assert.property(result.errors, 'user_ids')
        }
        const tooMany = Array.from({ length: MAX_BULK_USERS + 1 }, (_, index) => index + 1)
        assert.isFalse(parseBulkSiteAccess({ user_ids: tooMany, all_sites: true }).ok)
    })

    test('tanpa site dan tanpa all_sites ditolak (tidak diam-diam mencabut semua)', ({
        assert,
    }) => {
        for (const siteIds of [undefined, [], 'abc', [0], ['x']]) {
            const result = parseBulkSiteAccess({ user_ids: [1], organization_ids: siteIds })
            assert.isFalse(result.ok)
            if (!result.ok) assert.property(result.errors, 'organization_ids')
        }
        const tooMany = Array.from({ length: MAX_BULK_SITES + 1 }, (_, index) => index + 1)
        assert.isFalse(parseBulkSiteAccess({ user_ids: [1], organization_ids: tooMany }).ok)
    })

    test('mode di luar add / remove / replace ditolak', ({ assert }) => {
        const result = parseBulkSiteAccess({ user_ids: [1], all_sites: true, mode: 'hapus' })
        assert.isFalse(result.ok)
        if (!result.ok) assert.property(result.errors, 'mode')
    })

    test('semua kesalahan dilaporkan sekaligus', ({ assert }) => {
        const result = parseBulkSiteAccess({ mode: 'x' })
        assert.isFalse(result.ok)
        if (!result.ok) {
            assert.sameMembers(Object.keys(result.errors), ['user_ids', 'mode', 'organization_ids'])
        }
    })
})
