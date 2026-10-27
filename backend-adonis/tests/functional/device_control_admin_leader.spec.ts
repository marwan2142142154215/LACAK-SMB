import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import { makeDevice } from './rules_helpers.js'
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

test.group('Admin & leader: kunci device dan geofence', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    for (const role of ['admin', 'leader']) {
        test(`${role} mengunci, membuka kunci, dan mengelola geofence di site yang diberikan`, async ({
            client,
            assert,
        }) => {
            const mine = await site(`Site ${role} Milik`)
            const other = await site(`Site ${role} Lain`)
            const manager = await person(role, null, [mine])
            const device = await makeDevice(mine, manager.id)
            const foreignDevice = await makeDevice(other, manager.id)

            for (const command of ['lock', 'unlock']) {
                const sent = await client
                    .post(`/api/v1/devices/${device}/commands`)
                    .json({ command_type: command, issued_via: 'web_dashboard' })
                    .bearerToken(manager.bearer)
                sent.assertStatus(201)
            }
            const foreign = await client
                .post(`/api/v1/devices/${foreignDevice}/commands`)
                .json({ command_type: 'lock', issued_via: 'web_dashboard' })
                .bearerToken(manager.bearer)
            foreign.assertStatus(403)

            const rule = await client
                .post('/api/v1/geofence-rules')
                .json({ organization_id: mine, rule_name: 'Kantor', max_distance_meters: 50 })
                .bearerToken(manager.bearer)
            rule.assertStatus(201)
            const foreignRule = await client
                .post('/api/v1/geofence-rules')
                .json({
                    organization_id: other,
                    rule_name: 'Bukan site saya',
                    max_distance_meters: 50,
                })
                .bearerToken(manager.bearer)
            foreignRule.assertStatus(403)

            const list = await client.get('/api/v1/geofence-rules').bearerToken(manager.bearer)
            list.assertStatus(200)
            assert.deepEqual(
                list
                    .body()
                    .data.items.map((item: { organization_id: number }) => item.organization_id),
                [mine]
            )
        })
    }

    test('staf tetap tidak bisa mengunci device', async ({ client }) => {
        const mine = await site('Site Staf Kunci')
        const staff = await person('staff_viewer', mine)
        const device = await makeDevice(mine, staff.id)
        const sent = await client
            .post(`/api/v1/devices/${device}/commands`)
            .json({ command_type: 'lock', issued_via: 'web_dashboard' })
            .bearerToken(staff.bearer)
        sent.assertStatus(403)
    })
})
