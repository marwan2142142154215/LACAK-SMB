import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import PersonalAccessToken from '#models/PersonalAccessToken'
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
            username: `lok.${role}.${suffix}`,
            name: `Lok ${role} ${suffix}`,
            email: `lok.${role}.${suffix}@example.test`,
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

async function putLocation(userId: number, organizationId: number, lat: number, lng: number) {
    await db.table('staff_locations').insert({
        user_id: userId,
        organization_id: organizationId,
        latitude: lat,
        longitude: lng,
        accuracy_meters: 12,
        source: 'gps',
        confidence: 'high',
        is_mock: false,
        client: 'android',
        captured_at: new Date(),
        created_at: new Date(),
    })
}

test.group('Lokasi staf: GET /staff-locations', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('leader (radar.view) melihat lokasi staf di site-nya, bukan site lain', async ({
        client,
        assert,
    }) => {
        const mine = await site('Site Lokasi Milik')
        const other = await site('Site Lokasi Lain')
        const leader = await person('leader', null, [mine])
        const staff = await person('staff_viewer', mine)
        const outsider = await person('staff_viewer', other)
        await putLocation(staff.id, mine, -6.2, 106.8)
        await putLocation(outsider.id, other, -7, 110)

        const res = await client.get('/api/v1/staff-locations').bearerToken(leader.bearer)
        res.assertStatus(200)
        const items = res.body().data.items as Array<{
            user_id: number
            last_location: { latitude: string; source: string }
        }>
        const ids = items.map((item) => item.user_id)
        assert.include(ids, staff.id)
        assert.notInclude(ids, outsider.id)

        const mineItem = items.find((item) => item.user_id === staff.id)!
        assert.equal(mineItem.last_location.latitude, '-6.2000000')
        assert.equal(mineItem.last_location.source, 'gps')
    })

    test('staf tanpa izin radar.view ditolak (403)', async ({ client }) => {
        const mine = await site('Site Lokasi Staf')
        const staff = await person('staff_viewer', mine)
        const res = await client.get('/api/v1/staff-locations').bearerToken(staff.bearer)
        res.assertStatus(403)
    })
})
