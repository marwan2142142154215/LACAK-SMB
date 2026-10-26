import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import PersonalAccessToken from '#models/personal_access_token'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'

async function staffIn(organizationId: number, roleName = 'staff_viewer') {
    const suffix = randomBytes(4).toString('hex')
    const [user] = await db
        .table('users')
        .insert({
            username: `staf.roster.${suffix}`,
            name: `Staf Roster ${suffix}`,
            email: `staf.roster.${suffix}@example.test`,
            password: '$2y$10$Y18XUtkwVNaSkDxG0mGKX.51ec8i1y3rdvE4Cc.QSg9izFzIo/CiO',
            organization_id: organizationId,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])
    const role = await db.from('roles').where({ name: roleName, guard_name: 'web' }).firstOrFail()
    await db.table('model_has_roles').insert({
        role_id: role.id,
        model_type: LARAVEL_USER_MORPH,
        model_id: user.id,
    })
    return user.id as number
}

async function loginToken(
    userId: number,
    expiresAt: DateTime,
    deviceType: string | null = 'computer'
) {
    const plain = randomBytes(20).toString('hex')
    const token = await PersonalAccessToken.create({
        tokenableType: LARAVEL_USER_MORPH,
        tokenableId: userId,
        name: `web_dashboard-${Date.now()}`,
        deviceType,
        token: createHash('sha256').update(plain).digest('hex'),
        abilities: '["*"]',
        expiresAt,
    })
    return `${token.id}|${plain}`
}

test.group('Live Kerja: status Online di daftar staf', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('login tapi belum Mulai kerja = online; tidak login / token habis = offline', async ({
        client,
        assert,
    }) => {
        const [org] = await db
            .table('organizations')
            .insert({
                name: 'Site Roster',
                type: 'company_asset',
                unique_site_code: `UJI-${randomBytes(4).toString('hex').toUpperCase()}`,
                is_active: true,
                created_at: new Date(),
                updated_at: new Date(),
            })
            .returning(['id'])

        const loggedIn = await staffIn(org.id)
        const oldToken = await staffIn(org.id)
        const expired = await staffIn(org.id)
        const notLoggedIn = await staffIn(org.id)
        // Pengawas site: staf biasa hanya melihat dirinya sendiri (tes di bawah).
        const viewer = await staffIn(org.id, 'site_admin')

        await loginToken(loggedIn, DateTime.now().plus({ hours: 2 }))
        // Token lama sebelum kolom device_type: tetap dihitung login.
        await loginToken(oldToken, DateTime.now().plus({ hours: 1 }), null)
        await loginToken(expired, DateTime.now().minus({ minutes: 1 }))
        const viewerBearer = await loginToken(viewer, DateTime.now().plus({ hours: 2 }))

        const response = await client.get('/api/v1/live/sessions').bearerToken(viewerBearer)

        response.assertStatus(200)
        const statuses = Object.fromEntries(
            response
                .body()
                .data.roster.map((staff: { user_id: number; status: string }) => [
                    staff.user_id,
                    staff.status,
                ])
        )
        assert.equal(statuses[loggedIn], 'online')
        assert.equal(statuses[oldToken], 'online')
        assert.equal(statuses[expired], 'offline')
        assert.equal(statuses[notLoggedIn], 'offline')
        assert.equal(statuses[viewer], 'online')
    })
})

test.group('Ringkasan dashboard: staf online', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('menghitung staf dan staf yang masih login di site sendiri', async ({ client }) => {
        const newOrg = async () => {
            const [org] = await db
                .table('organizations')
                .insert({
                    name: 'Site Ringkasan',
                    type: 'company_asset',
                    unique_site_code: `UJI-${randomBytes(4).toString('hex').toUpperCase()}`,
                    is_active: true,
                    created_at: new Date(),
                    updated_at: new Date(),
                })
                .returning(['id'])
            return org.id as number
        }
        const orgId = await newOrg()
        const online = await staffIn(orgId)
        const expired = await staffIn(orgId)
        await staffIn(orgId) // tidak pernah login
        const viewer = await staffIn(orgId)
        await loginToken(await staffIn(await newOrg()), DateTime.now().plus({ hours: 1 })) // site lain

        await loginToken(online, DateTime.now().plus({ hours: 2 }))
        await loginToken(expired, DateTime.now().minus({ minutes: 1 }))
        const viewerBearer = await loginToken(viewer, DateTime.now().plus({ hours: 2 }))

        const response = await client.get('/api/v1/dashboard-summary').bearerToken(viewerBearer)

        response.assertStatus(200)
        response.assertBodyContains({ data: { staff_count: 4, staff_online_count: 2 } })
    })
})

test.group('Live Kerja: ruang leader', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    async function userWithRole(role: string) {
        const suffix = randomBytes(4).toString('hex')
        const [user] = await db
            .table('users')
            .insert({
                username: `uji.${role}.${suffix}`,
                name: `Uji ${role} ${suffix}`,
                email: `uji.${role}.${suffix}@example.test`,
                password: '$2y$10$Y18XUtkwVNaSkDxG0mGKX.51ec8i1y3rdvE4Cc.QSg9izFzIo/CiO',
                is_active: true,
                created_at: new Date(),
                updated_at: new Date(),
            })
            .returning(['id'])
        const roleRow = await db
            .from('roles')
            .where({ name: role, guard_name: 'web' })
            .firstOrFail()
        await db.table('model_has_roles').insert({
            role_id: roleRow.id,
            model_type: LARAVEL_USER_MORPH,
            model_id: user.id,
        })
        return {
            id: user.id as number,
            bearer: await loginToken(user.id, DateTime.now().plus({ hours: 2 })),
        }
    }

    test('leader Mulai kerja masuk ruang leader, tanpa site', async ({ client, assert }) => {
        const leader = await userWithRole('leader')

        const response = await client
            .post('/api/v1/live/sessions/start')
            .json({ device: 'computer' })
            .bearerToken(leader.bearer)

        response.assertStatus(201)
        assert.equal(response.body().data.room, 'leaders')
        assert.isNull(response.body().data.session.organization_id)
    })

    test('Mulai kerja: komputer & APK Live Kerja boleh, browser HP / APK lama ditolak', async ({
        client,
    }) => {
        for (const [device, expected] of [
            [undefined, 422],
            ['phone', 422],
            ['android_app', 201],
        ] as const) {
            const leader = await userWithRole('leader')
            const response = await client
                .post('/api/v1/live/sessions/start')
                .json(device ? { device } : {})
                .bearerToken(leader.bearer)
            response.assertStatus(expected)
        }
    })

    test('wajah hilang < 5 menit tidak dicatat, >= 5 menit tetap dicatat', async ({
        client,
        assert,
    }) => {
        const leader = await userWithRole('leader')
        const started = await client
            .post('/api/v1/live/sessions/start')
            .json({ device: 'computer' })
            .bearerToken(leader.bearer)
        started.assertStatus(201)
        const sessionId = started.body().data.session.id
        const heartbeat = async (faceMissing: boolean) => {
            const response = await client
                .post('/api/v1/live/sessions/heartbeat')
                .json({ camera_active: true, screen_active: true, face_missing: faceMissing })
                .bearerToken(leader.bearer)
            response.assertStatus(200)
        }
        const faceEvents = async () => {
            const rows = await db
                .from('work_session_events')
                .where('work_session_id', sessionId)
                .whereIn('type', ['face_lost', 'face_back'])
                .orderBy('id')
            return rows.map((row) => row.type)
        }

        // Kembali sebentar kemudian: catatan face_lost dihapus, face_back tidak dicatat.
        await heartbeat(true)
        assert.deepEqual(await faceEvents(), ['face_lost'])
        await heartbeat(false)
        assert.deepEqual(await faceEvents(), [])

        // Hilang 6 menit: tetap tercatat lengkap.
        await heartbeat(true)
        await db
            .from('work_session_events')
            .where('work_session_id', sessionId)
            .where('type', 'face_lost')
            .update({ occurred_at: new Date(Date.now() - 6 * 60_000) })
        await heartbeat(false)
        assert.deepEqual(await faceEvents(), ['face_lost', 'face_back'])
    })

    test('ruang leader bisa ditonton admin, tidak bisa oleh staf', async ({ client }) => {
        const admin = await userWithRole('admin')
        const allowed = await client
            .post('/api/v1/live/watch-token')
            .json({ room: 'leaders' })
            .bearerToken(admin.bearer)
        allowed.assertStatus(200)
        allowed.assertBodyContains({ data: { room: 'leaders' } })

        const [org] = await db
            .table('organizations')
            .insert({
                name: 'Site Leader',
                type: 'company_asset',
                unique_site_code: `UJI-${randomBytes(4).toString('hex').toUpperCase()}`,
                is_active: true,
                created_at: new Date(),
                updated_at: new Date(),
            })
            .returning(['id'])
        const staff = await staffIn(org.id)
        const staffBearer = await loginToken(staff, DateTime.now().plus({ hours: 2 }))
        const denied = await client
            .post('/api/v1/live/watch-token')
            .json({ room: 'leaders' })
            .bearerToken(staffBearer)
        denied.assertStatus(403)
    })

    test('staf biasa hanya melihat dirinya sendiri di daftar & tidak bisa menonton', async ({
        client,
        assert,
    }) => {
        const [org] = await db
            .table('organizations')
            .insert({
                name: 'Site Sendiri',
                type: 'company_asset',
                unique_site_code: `UJI-${randomBytes(4).toString('hex').toUpperCase()}`,
                is_active: true,
                created_at: new Date(),
                updated_at: new Date(),
            })
            .returning(['id'])

        const me = await staffIn(org.id)
        const colleague = await staffIn(org.id)
        await loginToken(colleague, DateTime.now().plus({ hours: 2 }))
        const bearer = await loginToken(me, DateTime.now().plus({ hours: 2 }))

        const sessions = await client.get('/api/v1/live/sessions').bearerToken(bearer)
        sessions.assertStatus(200)
        assert.deepEqual(
            sessions.body().data.roster.map((staff: { user_id: number }) => staff.user_id),
            [me]
        )

        const overview = await client.get('/api/v1/live/overview').bearerToken(bearer)
        overview.assertStatus(200)
        assert.deepEqual(
            overview.body().data.roster.map((staff: { user_id: number }) => staff.user_id),
            [me]
        )

        const watch = await client
            .post('/api/v1/live/watch-token')
            .json({ organization_id: org.id })
            .bearerToken(bearer)
        watch.assertStatus(403)

        const recordings = await client
            .get('/api/v1/live/recordings')
            .qs({ user_id: colleague })
            .bearerToken(bearer)
        recordings.assertStatus(403)
    })
})
