import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import PersonalAccessToken from '#models/PersonalAccessToken'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'

/*
| Menu Peran (izin + cakupan site, pengaman anti naik pangkat) dan nama site unik tanpa
| membedakan huruf besar/kecil. Peran & izin dasar dari seedRolesAndPermissions (bootstrap).
*/

async function userWithRole(role: string) {
    const suffix = randomBytes(4).toString('hex')
    const [user] = await db
        .table('users')
        .insert({
            username: `uji.${suffix}`,
            name: `Uji ${suffix}`,
            email: `uji.${suffix}@example.test`,
            password: '$2y$10$Y18XUtkwVNaSkDxG0mGKX.51ec8i1y3rdvE4Cc.QSg9izFzIo/CiO',
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])
    const roleRow = await db.from('roles').where({ name: role, guard_name: 'web' }).firstOrFail()
    await db.table('model_has_roles').insert({
        role_id: roleRow.id,
        model_type: LARAVEL_USER_MORPH,
        model_id: user.id,
    })
    const plain = randomBytes(20).toString('hex')
    const token = await PersonalAccessToken.create({
        tokenableType: LARAVEL_USER_MORPH,
        tokenableId: user.id,
        name: `web_dashboard-${Date.now()}`,
        deviceType: 'computer',
        token: createHash('sha256').update(plain).digest('hex'),
        abilities: '["*"]',
        expiresAt: DateTime.now().plus({ hours: 2 }),
    })
    return { id: user.id as number, bearer: `${token.id}|${plain}` }
}

const newRole = {
    name: 'audit_uji',
    label: 'Audit Uji',
    description: 'Hanya melihat',
    site_scope: 'granted',
    permissions: ['devices.view', 'live.watch'],
}

test.group('Peran: kelola peran (roles.manage)', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('super_admin membuat peran baru lalu mengubah izinnya', async ({ client, assert }) => {
        const root = await userWithRole('super_admin')

        const created = await client.post('/api/v1/roles').bearerToken(root.bearer).json(newRole)
        created.assertStatus(201)
        const id = created.body().data.id
        assert.deepEqual(created.body().data.permissions.sort(), ['devices.view', 'live.watch'])
        assert.equal(created.body().data.site_scope, 'granted')
        assert.isFalse(created.body().data.is_system)

        const updated = await client
            .put(`/api/v1/roles/${id}`)
            .bearerToken(root.bearer)
            .json({ ...newRole, permissions: ['devices.view'], site_scope: 'own' })
        updated.assertStatus(200)
        assert.deepEqual(updated.body().data.permissions, ['devices.view'])
        assert.equal(updated.body().data.site_scope, 'own')
    })

    test('kode peran kembar (beda huruf besar/kecil) dan izin tak dikenal ditolak', async ({
        client,
    }) => {
        const root = await userWithRole('super_admin')
        await client.post('/api/v1/roles').bearerToken(root.bearer).json(newRole)

        const duplicate = await client
            .post('/api/v1/roles')
            .bearerToken(root.bearer)
            .json({ ...newRole, name: 'AUDIT_UJI' })
        duplicate.assertStatus(422)

        const unknown = await client
            .post('/api/v1/roles')
            .bearerToken(root.bearer)
            .json({ ...newRole, name: 'lain_uji', permissions: ['tidak.ada'] })
        unknown.assertStatus(422)
    })

    test('peran bawaan: super_admin dikunci, cakupan bawaan tetap, tidak bisa dihapus', async ({
        client,
    }) => {
        const root = await userWithRole('super_admin')
        const roles = await db.from('roles').whereIn('name', ['super_admin', 'admin'])
        const superRole = roles.find((row) => row.name === 'super_admin')
        const adminRole = roles.find((row) => row.name === 'admin')

        const lockedUpdate = await client
            .put(`/api/v1/roles/${superRole.id}`)
            .bearerToken(root.bearer)
            .json({ ...newRole, site_scope: 'all' })
        lockedUpdate.assertStatus(403)

        const scopeChange = await client
            .put(`/api/v1/roles/${adminRole.id}`)
            .bearerToken(root.bearer)
            .json({ ...newRole, site_scope: 'all' })
        scopeChange.assertStatus(422)

        const remove = await client.delete(`/api/v1/roles/${adminRole.id}`).bearerToken(root.bearer)
        remove.assertStatus(403)
    })

    test('peran yang masih dipakai staf tidak bisa dihapus; yang kosong bisa', async ({
        client,
    }) => {
        const root = await userWithRole('super_admin')
        const created = await client.post('/api/v1/roles').bearerToken(root.bearer).json(newRole)
        const id = created.body().data.id
        await db.table('model_has_roles').insert({
            role_id: id,
            model_type: LARAVEL_USER_MORPH,
            model_id: root.id,
        })

        const blocked = await client.delete(`/api/v1/roles/${id}`).bearerToken(root.bearer)
        blocked.assertStatus(422)

        await db.from('model_has_roles').where('role_id', id).delete()
        const removed = await client.delete(`/api/v1/roles/${id}`).bearerToken(root.bearer)
        removed.assertStatus(200)
    })

    test('selain pemegang roles.manage ditolak, tapi pemegang users.manage boleh membaca pilihan peran', async ({
        client,
    }) => {
        const admin = await userWithRole('admin')
        const list = await client.get('/api/v1/roles').bearerToken(admin.bearer)
        list.assertStatus(403)
        const create = await client.post('/api/v1/roles').bearerToken(admin.bearer).json(newRole)
        create.assertStatus(403)
        const options = await client.get('/api/v1/roles/options').bearerToken(admin.bearer)
        options.assertStatus(403)

        const root = await userWithRole('super_admin')
        const rootOptions = await client.get('/api/v1/roles/options').bearerToken(root.bearer)
        rootOptions.assertStatus(200)
    })

    test('peran buatan sendiri dengan cakupan granted ikut mendapat akses site, bukan semua site', async ({
        client,
        assert,
    }) => {
        const root = await userWithRole('super_admin')
        const created = await client.post('/api/v1/roles').bearerToken(root.bearer).json(newRole)
        assert.equal(created.body().data.site_scope, 'granted')

        const auditor = await userWithRole('super_admin')
        await db.from('model_has_roles').where('model_id', auditor.id).delete()
        await db.table('model_has_roles').insert({
            role_id: created.body().data.id,
            model_type: LARAVEL_USER_MORPH,
            model_id: auditor.id,
        })
        const me = await client.get('/api/v1/auth/me').bearerToken(auditor.bearer)
        me.assertStatus(200)
        assert.equal(me.body().data.site_scope, 'granted')
        assert.deepEqual(me.body().data.permissions.sort(), ['devices.view', 'live.watch'])
    })
})

test.group('Site: nama unik tanpa membedakan huruf besar/kecil', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('situs1, SitUs1, SITUS1, dan " situs1 " dianggap sama', async ({ client, assert }) => {
        const root = await userWithRole('super_admin')
        const first = await client
            .post('/api/v1/organizations')
            .bearerToken(root.bearer)
            .json({ name: '  situs1 ', type: 'company_asset' })
        first.assertStatus(201)
        assert.equal(first.body().data.name, 'situs1')

        for (const name of ['SitUs1', 'SITUS1', ' situs1']) {
            const duplicate = await client
                .post('/api/v1/organizations')
                .bearerToken(root.bearer)
                .json({ name, type: 'company_asset' })
            duplicate.assertStatus(422)
        }
        const other = await client
            .post('/api/v1/organizations')
            .bearerToken(root.bearer)
            .json({ name: 'situs2', type: 'company_asset' })
        other.assertStatus(201)
    })

    test('mengganti nama menjadi nama site lain ditolak, mengubah huruf besar/kecil sendiri boleh', async ({
        client,
    }) => {
        const root = await userWithRole('super_admin')
        const a = await client
            .post('/api/v1/organizations')
            .bearerToken(root.bearer)
            .json({ name: 'Alpha', type: 'company_asset' })
        const b = await client
            .post('/api/v1/organizations')
            .bearerToken(root.bearer)
            .json({ name: 'Beta', type: 'company_asset' })

        const clash = await client
            .put(`/api/v1/organizations/${b.body().data.id}`)
            .bearerToken(root.bearer)
            .json({ name: 'ALPHA' })
        clash.assertStatus(422)

        const own = await client
            .put(`/api/v1/organizations/${a.body().data.id}`)
            .bearerToken(root.bearer)
            .json({ name: 'ALPHA' })
        own.assertStatus(200)
    })
})
