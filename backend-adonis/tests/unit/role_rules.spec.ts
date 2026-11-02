import { test } from '@japa/runner'
import {
    canSeeLevel,
    effectiveLevel,
    levelExceedsActor,
    parseRoleInput,
    permissionsActorLacks,
    scopeExceedsActor,
    watchableRoleNames,
    widestScope,
} from '#services/RoleRules'
import { normalizeSiteName } from '#services/SiteName'

const valid = {
    name: 'Audit_Site',
    label: '  Audit  ',
    description: '',
    site_scope: 'granted',
    permissions: ['devices.view', 'devices.view', 'live.watch'],
}

test.group('Peran: validasi isian', () => {
    test('isian lengkap diterima, kode dirapikan, izin dibuat unik', ({ assert }) => {
        const result = parseRoleInput(valid, true)
        assert.isTrue(result.ok)
        if (result.ok) {
            assert.equal(result.data.name, 'audit_site')
            assert.equal(result.data.label, 'Audit')
            assert.isNull(result.data.description)
            assert.deepEqual(result.data.permissions, ['devices.view', 'live.watch'])
        }
    })

    test('kode peran tidak valid ditolak saat membuat, tidak diperlukan saat mengubah', ({
        assert,
    }) => {
        for (const name of ['', 'A', '1abc', 'ada spasi', 'huruf-strip', 'x'.repeat(41)]) {
            assert.isFalse(parseRoleInput({ ...valid, name }, true).ok, name)
        }
        assert.isTrue(parseRoleInput({ ...valid, name: undefined }, false).ok)
    })

    test('cakupan, nama, dan izin yang salah ditolak', ({ assert }) => {
        const result = parseRoleInput(
            { ...valid, label: ' ', site_scope: 'semua', permissions: 'x' },
            true
        )
        assert.isFalse(result.ok)
        if (!result.ok) {
            assert.deepEqual(Object.keys(result.errors).sort(), [
                'label',
                'permissions',
                'site_scope',
            ])
        }
    })
})

test.group('Peran: pencegahan naik pangkat', () => {
    test('hanya izin BARU yang tidak dimiliki pelaku yang dihitung', ({ assert }) => {
        const lacking = permissionsActorLacks(
            ['devices.view', 'live.watch'],
            ['users.manage'],
            ['users.manage', 'devices.view', 'security.manage']
        )
        assert.deepEqual(lacking, ['security.manage'])
    })

    test('cakupan tidak boleh lebih luas dari milik pelaku, kecuali tidak berubah', ({
        assert,
    }) => {
        assert.isTrue(scopeExceedsActor('granted', 'own', 'all'))
        assert.isFalse(scopeExceedsActor('granted', 'own', 'granted'))
        assert.isFalse(scopeExceedsActor('own', 'all', 'all'))
        assert.isTrue(scopeExceedsActor('own', null, 'granted'))
    })

    test('cakupan terluas dari beberapa peran yang menang', ({ assert }) => {
        assert.equal(widestScope([]), 'own')
        assert.equal(widestScope(['own', 'granted']), 'granted')
        assert.equal(widestScope(['granted', 'all', 'own']), 'all')
    })
})

test.group('Nama site: normalisasi', () => {
    test('spasi tepi dibuang dan spasi berderet diringkas', ({ assert }) => {
        assert.equal(normalizeSiteName('  Situs   1 '), 'Situs 1')
        assert.equal(normalizeSiteName('SITUS1'), 'SITUS1')
    })
})

test.group('Peran: tingkatan (level)', () => {
    const roles = [
        { name: 'super_admin', level: 0 },
        { name: 'admin', level: 10 },
        { name: 'leader', level: 50 },
        { name: 'staff_viewer', level: 100 },
        { name: 'staf_lain', level: 100 },
    ]

    test('level 0 melihat semua, selain itu hanya level yang lebih besar', ({ assert }) => {
        assert.isTrue(canSeeLevel(0, 0))
        assert.isTrue(canSeeLevel(0, 100))
        assert.isTrue(canSeeLevel(50, 100))
        assert.isFalse(canSeeLevel(50, 50))
        assert.isFalse(canSeeLevel(50, 10))
        assert.isFalse(canSeeLevel(100, 100))
        assert.isFalse(canSeeLevel(100, 0))
    })

    test('level user dengan banyak peran = yang tertinggi; tanpa peran = paling bawah', ({
        assert,
    }) => {
        assert.equal(effectiveLevel([50, 10, 100]), 10)
        assert.equal(effectiveLevel([]), 100)
    })

    test('peran yang boleh ditonton dihitung dari level, lalu dipersempit pengaturan peran', ({
        assert,
    }) => {
        assert.isNull(watchableRoleNames(0, roles, null))
        assert.deepEqual(watchableRoleNames(0, roles, ['leader']), ['leader'])
        assert.deepEqual(watchableRoleNames(10, roles, null), [
            'leader',
            'staff_viewer',
            'staf_lain',
        ])
        assert.deepEqual(watchableRoleNames(50, roles, null), ['staff_viewer', 'staf_lain'])
        assert.deepEqual(watchableRoleNames(50, roles, ['staff_viewer', 'admin']), ['staff_viewer'])
        assert.deepEqual(watchableRoleNames(100, roles, null), [])
    })

    test('level diterima 0-100 bilangan bulat, selain itu ditolak; kosong = tidak diubah', ({
        assert,
    }) => {
        for (const level of [0, 50, 100, '30']) {
            const result = parseRoleInput({ ...valid, level }, false)
            assert.isTrue(result.ok, String(level))
        }
        for (const level of [-1, 101, 1.5, 'abc', true]) {
            assert.isFalse(parseRoleInput({ ...valid, level }, false).ok, String(level))
        }
        const unchanged = parseRoleInput(valid, false)
        assert.isTrue(unchanged.ok)
        if (unchanged.ok) assert.isUndefined(unchanged.data.level)
    })

    test('pelaku tidak bisa memberi level lebih tinggi dari levelnya sendiri', ({ assert }) => {
        assert.isTrue(levelExceedsActor(50, 100, 20))
        assert.isFalse(levelExceedsActor(50, 100, 50))
        assert.isFalse(levelExceedsActor(50, 100, 80))
        assert.isFalse(levelExceedsActor(50, 20, 20))
        assert.isFalse(levelExceedsActor(0, 100, 0))
    })
})
