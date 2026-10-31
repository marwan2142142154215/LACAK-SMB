import { test } from '@japa/runner'
import {
    parseRoleInput,
    permissionsActorLacks,
    scopeExceedsActor,
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
