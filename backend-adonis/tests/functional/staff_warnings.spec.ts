import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import PersonalAccessToken from '#models/personal_access_token'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'

async function site(name: string) {
    const [org] = await db
        .table('organizations')
        .insert({
            name,
            type: 'company_asset',
            unique_site_code: `UJI-${randomBytes(4).toString('hex').toUpperCase()}`,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])
    return org.id as number
}

/** User dengan satu peran + bearer token; admin/leader diberi akses ke [granted]. */
async function person(role: string, organizationId: number | null, granted: number[] = []) {
    const suffix = randomBytes(4).toString('hex')
    const [user] = await db
        .table('users')
        .insert({
            username: `kerja.${role}.${suffix}`,
            name: `Kerja ${role} ${suffix}`,
            email: `kerja.${role}.${suffix}@example.test`,
            password: '$2y$10$Y18XUtkwVNaSkDxG0mGKX.51ec8i1y3rdvE4Cc.QSg9izFzIo/CiO',
            organization_id: organizationId,
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
    for (const id of granted) {
        await db.table('user_site_access').insert({
            user_id: user.id,
            organization_id: id,
            created_at: new Date(),
            updated_at: new Date(),
        })
    }
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

test.group('Peringatan staf', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('leader memberi peringatan, staf melihat popup sampai mengonfirmasi', async ({
        client,
        assert,
    }) => {
        const mine = await site('Site Peringatan Milik')
        const other = await site('Site Peringatan Lain')
        const leader = await person('leader', null, [mine])
        const staff = await person('staff_viewer', mine)
        const outsider = await person('staff_viewer', other)

        const byStaff = await client
            .post('/api/v1/staff-warnings')
            .json({ user_id: outsider.id, level: 'teguran', message: 'Coba-coba' })
            .bearerToken(staff.bearer)
        byStaff.assertStatus(403)

        const foreign = await client
            .post('/api/v1/staff-warnings')
            .json({ user_id: outsider.id, level: 'teguran', message: 'Bukan site Anda' })
            .bearerToken(leader.bearer)
        foreign.assertStatus(404)

        const self = await client
            .post('/api/v1/staff-warnings')
            .json({ user_id: leader.id, level: 'teguran', message: 'Diri sendiri' })
            .bearerToken(leader.bearer)
        self.assertStatus(422)

        const created = await client
            .post('/api/v1/staff-warnings')
            .json({ user_id: staff.id, level: 'keras', message: 'Kamera ditutup saat kerja.' })
            .bearerToken(leader.bearer)
        created.assertStatus(201)
        const id = created.body().data.id

        const pending = await client.get('/api/v1/staff-warnings/pending').bearerToken(staff.bearer)
        pending.assertStatus(200)
        assert.lengthOf(pending.body().data.items, 1)
        assert.equal(pending.body().data.items[0].level_label, 'Peringatan keras')
        const leaderRow = await db.from('users').where('id', leader.id).first()
        assert.equal(pending.body().data.items[0].issuer_name, leaderRow.name)

        // Orang lain tidak bisa mengonfirmasi peringatan milik staf ini.
        const stranger = await client
            .post(`/api/v1/staff-warnings/${id}/acknowledge`)
            .bearerToken(outsider.bearer)
        stranger.assertStatus(404)

        const ack = await client
            .post(`/api/v1/staff-warnings/${id}/acknowledge`)
            .bearerToken(staff.bearer)
        ack.assertStatus(200)
        const after = await client.get('/api/v1/staff-warnings/pending').bearerToken(staff.bearer)
        assert.lengthOf(after.body().data.items, 0)

        const history = await client
            .get('/api/v1/staff-warnings')
            .qs({ user_id: staff.id })
            .bearerToken(leader.bearer)
        history.assertStatus(200)
        assert.lengthOf(history.body().data.items, 1)
        assert.isNotNull(history.body().data.items[0].acknowledged_at)

        const staffHistory = await client.get('/api/v1/staff-warnings').bearerToken(staff.bearer)
        staffHistory.assertStatus(403)
    })
})
