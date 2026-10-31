import { test } from '@japa/runner'
import { parseBulkUserUpdate, parseEmailList } from '#services/BulkUserUpdate'

test.group('Update massal staf: validasi input', () => {
    test('hanya peran: site tidak diubah dan tidak perlu diisi', ({ assert }) => {
        const result = parseBulkUserUpdate({ user_ids: [1, '2', 2], role: 'audit' })
        assert.isTrue(result.ok)
        if (result.ok) {
            assert.deepEqual(result.data, {
                userIds: [1, 2],
                role: 'audit',
                status: null,
                sites: null,
            })
        }
    })

    test('peran + status + site sekaligus', ({ assert }) => {
        const result = parseBulkUserUpdate({
            user_ids: [3],
            role: 'leader',
            status: 'active',
            site_mode: 'replace',
            organization_ids: ['5', 6],
        })
        assert.isTrue(result.ok)
        if (result.ok) {
            assert.equal(result.data.status, 'active')
            assert.deepEqual(result.data.sites, { mode: 'replace', organizationIds: [5, 6] })
        }
    })

    test('semua site menggantikan daftar site', ({ assert }) => {
        const result = parseBulkUserUpdate({ user_ids: [3], site_mode: 'add', all_sites: true })
        assert.isTrue(result.ok)
        if (result.ok) assert.deepEqual(result.data.sites, { mode: 'add', organizationIds: 'all' })
    })

    test('tanpa satu pun perubahan ditolak', ({ assert }) => {
        const result = parseBulkUserUpdate({ user_ids: [1] })
        assert.isFalse(result.ok)
        if (!result.ok) assert.property(result.errors, 'changes')
    })

    test('daftar staf kosong, status, peran, dan mode site yang salah ditolak', ({ assert }) => {
        const result = parseBulkUserUpdate({
            user_ids: [],
            role: 'Huruf Besar',
            status: 'hapus',
            site_mode: 'ganti',
        })
        assert.isFalse(result.ok)
        if (!result.ok) {
            for (const field of ['user_ids', 'role', 'status', 'site_mode']) {
                assert.property(result.errors, field)
            }
        }
    })

    test('mode site diisi tapi site belum dipilih ditolak', ({ assert }) => {
        const result = parseBulkUserUpdate({ user_ids: [1], site_mode: 'add' })
        assert.isFalse(result.ok)
        if (!result.ok) assert.property(result.errors, 'organization_ids')
    })

    test('kolom site yang kosong tidak mengganggu update peran saja', ({ assert }) => {
        const result = parseBulkUserUpdate({
            user_ids: [1],
            status: 'suspended',
            organization_ids: [],
        })
        assert.isTrue(result.ok)
    })
})

test.group('Update massal staf: daftar email tempelan', () => {
    test('email dirapikan, dibuat huruf kecil, unik; potongan bukan email dilaporkan', ({
        assert,
    }) => {
        const result = parseEmailList(['A@Gmail.com', ' a@gmail.com ', 'b@x.id', 'bukan-email', ''])
        assert.deepEqual(result, { emails: ['a@gmail.com', 'b@x.id'], invalid: ['bukan-email'] })
    })

    test('bukan array atau berisi non-teks ditolak', ({ assert }) => {
        assert.isNull(parseEmailList('a@b.com'))
        assert.isNull(parseEmailList(['a@b.com', 5]))
    })
})
