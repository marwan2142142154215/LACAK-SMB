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
async function userWithRole(role: string, organizationId: number | null, granted: number[] = []) {
    const suffix = randomBytes(4).toString('hex')
    const [user] = await db
        .table('users')
        .insert({
            username: `apk.${role}.${suffix}`,
            name: `APK ${role} ${suffix}`,
            email: `apk.${role}.${suffix}@example.test`,
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
    return `${token.id}|${plain}`
}

test.group('Briefing: site yang diundang', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('leader tanpa site tidak bisa membuat briefing untuk semua site', async ({
        client,
        assert,
    }) => {
        const bearer = await userWithRole('leader', null)
        const response = await client
            .post('/api/v1/briefings')
            .json({ title: 'Briefing pagi', roles: ['staff_viewer'] })
            .bearerToken(bearer)

        response.assertStatus(403)
        const count = await db.from('briefings').count('* as total').first()
        assert.equal(Number(count.total), 0)
    })

    test('leader memilih peserta: hanya di site-nya, hanya yang diundang bisa gabung', async ({
        client,
        assert,
    }) => {
        const mine = await site('Site Briefing Milik')
        const other = await site('Site Briefing Lain')
        const leader = await userWithRole('leader', null, [mine])
        const invited = await userWithRole('staff_viewer', mine)
        const notInvited = await userWithRole('staff_viewer', mine)
        const outsider = await userWithRole('staff_viewer', other)
        const idOf = async (bearer: string) => {
            const me = await client.get('/api/v1/auth/me').bearerToken(bearer)
            return me.body().data.id as number
        }

        const list = await client
            .get('/api/v1/briefings')
            .qs({ with_people: 1 })
            .bearerToken(leader)
        const people = list.body().data.people.map((person: { id: number }) => person.id)
        assert.include(people, await idOf(invited))
        assert.notInclude(people, await idOf(outsider))

        const foreign = await client
            .post('/api/v1/briefings')
            .json({ title: 'Rapat kecil', user_ids: [await idOf(outsider)] })
            .bearerToken(leader)
        foreign.assertStatus(403)

        const started = await client
            .post('/api/v1/briefings')
            .json({ title: 'Rapat kecil', user_ids: [await idOf(invited)] })
            .bearerToken(leader)
        started.assertStatus(201)
        assert.isTrue(started.body().data.briefing.camera_on_join)
        const id = started.body().data.briefing.id

        const joined = await client.post(`/api/v1/briefings/${id}/join`).bearerToken(invited)
        joined.assertStatus(200)
        assert.isTrue(joined.body().data.briefing.camera_on_join)
        const denied = await client.post(`/api/v1/briefings/${id}/join`).bearerToken(notInvited)
        denied.assertStatus(403)
    })
})

test.group('Build APK: peran yang boleh', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('leader & admin boleh di site yang dipegang; staf ditolak', async ({ client }) => {
        const mine = await site('Site APK Milik')
        const other = await site('Site APK Lain')

        for (const role of ['leader', 'admin']) {
            const bearer = await userWithRole(role, null, [mine])
            const list = await client.get('/api/v1/apk-builds').bearerToken(bearer)
            list.assertStatus(200)

            const consents = await client
                .get('/api/v1/consent-documents')
                .qs({ organization_id: mine })
                .bearerToken(bearer)
            consents.assertStatus(200)

            const foreign = await client
                .post('/api/v1/apk-builds/generate')
                .json({ organization_id: other, apk_type: 'live', version: '1.0.0' })
                .bearerToken(bearer)
            foreign.assertStatus(403)
        }

        const staff = await userWithRole('staff_viewer', mine)
        const denied = await client.get('/api/v1/apk-builds').bearerToken(staff)
        denied.assertStatus(403)
        const deniedConsents = await client.get('/api/v1/consent-documents').bearerToken(staff)
        deniedConsents.assertStatus(403)
    })

    test('SMB Live Kerja cukup satu: build kedua ditolak selama yang lama ada', async ({
        client,
        assert,
    }) => {
        const mine = await site('Site APK Live')
        const bearer = await userWithRole('admin', null, [mine])
        const builder = await db.from('users').orderBy('id', 'desc').select('id').firstOrFail()
        await db.table('apk_builds').insert({
            built_by: builder.id,
            organization_id: mine,
            apk_type: 'live',
            version: '1.0.0',
            status: 'success',
            embedded_site_code: 'UJI-LIVE',
            created_at: new Date(),
            updated_at: new Date(),
        })

        const response = await client
            .post('/api/v1/apk-builds/generate')
            .json({ organization_id: mine, apk_type: 'live', version: '1.0.1' })
            .bearerToken(bearer)

        response.assertStatus(422)
        assert.include(response.body().message, 'sudah ada')
        const count = await db
            .from('apk_builds')
            .where('apk_type', 'live')
            .count('* as total')
            .first()
        assert.equal(Number(count.total), 1)
    })
})
