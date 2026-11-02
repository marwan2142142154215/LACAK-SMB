import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import PersonalAccessToken from '#models/PersonalAccessToken'
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
                    name: `Site Ringkasan ${randomBytes(3).toString('hex')}`,
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

test.group('Live Kerja: Ruang pusat & semua peran', (group) => {
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

    test('leader Mulai kerja masuk Ruang pusat, tanpa site', async ({ client, assert }) => {
        const leader = await userWithRole('leader')

        const response = await client
            .post('/api/v1/live/sessions/start')
            .json({ device: 'computer' })
            .bearerToken(leader.bearer)

        response.assertStatus(201)
        assert.equal(response.body().data.room, 'pusat-leader')
        assert.isNull(response.body().data.session.organization_id)
        assert.equal(response.body().data.session.live_role, 'leader')
    })

    test('iPhone Mulai kerja kamera saja: hanya dari browser iOS, sesi ditandai camera_only', async ({
        client,
        assert,
    }) => {
        const leader = await userWithRole('leader')
        const IPHONE =
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

        // Klaim iPhone dari komputer ditolak (layar tetap wajib di komputer).
        const spoofed = await client
            .post('/api/v1/live/sessions/start')
            .header('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0')
            .json({ device: 'ios_camera' })
            .bearerToken(leader.bearer)
        spoofed.assertStatus(422)

        const started = await client
            .post('/api/v1/live/sessions/start')
            .header('User-Agent', IPHONE)
            .json({ device: 'ios_camera' })
            .bearerToken(leader.bearer)
        started.assertStatus(201)
        assert.isTrue(started.body().data.session.camera_only)

        // Kamera menyala tanpa layar = Working (bukan Screen off).
        const beat = await client
            .post('/api/v1/live/sessions/heartbeat')
            .json({ camera_active: true, screen_active: false })
            .bearerToken(leader.bearer)
        beat.assertStatus(200)
        assert.equal(beat.body().data.status, 'working')

        // Dilanjutkan dari komputer: kembali wajib layar.
        const resumed = await client
            .post('/api/v1/live/sessions/start')
            .json({ device: 'computer' })
            .bearerToken(leader.bearer)
        resumed.assertStatus(201)
        assert.isFalse(resumed.body().data.session.camera_only)
    })

    test('izin live.screen-optional: sesi ditandai screen_optional dan layar tertutup tetap Working', async ({
        client,
        assert,
    }) => {
        const leader = await userWithRole('leader')
        const start = () =>
            client
                .post('/api/v1/live/sessions/start')
                .json({ device: 'computer' })
                .bearerToken(leader.bearer)
        const beat = () =>
            client
                .post('/api/v1/live/sessions/heartbeat')
                .json({ camera_active: true, screen_active: false })
                .bearerToken(leader.bearer)

        // Tanpa izin: layar tertutup = Screen off.
        const before = await start()
        before.assertStatus(201)
        assert.isFalse(before.body().data.session.screen_optional)
        const closedBefore = await beat()
        assert.equal(closedBefore.body().data.status, 'screen_off')

        // Peran leader diberi izin lewat menu Peran: berlaku saat siaran dilanjutkan/dimulai lagi.
        const permission = await db
            .from('permissions')
            .where({ name: 'live.screen-optional', guard_name: 'web' })
            .firstOrFail()
        const role = await db
            .from('roles')
            .where({ name: 'leader', guard_name: 'web' })
            .firstOrFail()
        await db
            .table('role_has_permissions')
            .insert({ role_id: role.id, permission_id: permission.id })

        const after = await start()
        after.assertStatus(201)
        assert.isTrue(after.body().data.session.screen_optional)
        const closedAfter = await beat()
        assert.equal(closedAfter.body().data.status, 'working')
    })

    test('peran buatan sendiri bisa Live lewat izin live.broadcast, di room site + perannya', async ({
        client,
        assert,
    }) => {
        const [org] = await db
            .table('organizations')
            .insert({
                name: `Site Operator ${randomBytes(3).toString('hex')}`,
                type: 'company_asset',
                unique_site_code: `UJI-${randomBytes(4).toString('hex').toUpperCase()}`,
                is_active: true,
                created_at: new Date(),
                updated_at: new Date(),
            })
            .returning(['id'])
        const [role] = await db
            .table('roles')
            .insert({ name: 'operator', guard_name: 'web', label: 'Operator', site_scope: 'own' })
            .returning(['id'])
        const operator = await staffIn(org.id, 'operator')
        const bearer = await loginToken(operator, DateTime.now().plus({ hours: 2 }))

        // Tanpa izin: ditolak.
        const denied = await client
            .post('/api/v1/live/sessions/start')
            .json({ device: 'computer' })
            .bearerToken(bearer)
        denied.assertStatus(403)

        const broadcast = await db.from('permissions').where('name', 'live.broadcast').firstOrFail()
        await db
            .table('role_has_permissions')
            .insert({ role_id: role.id, permission_id: broadcast.id })

        const started = await client
            .post('/api/v1/live/sessions/start')
            .json({ device: 'computer' })
            .bearerToken(bearer)
        started.assertStatus(201)
        assert.equal(started.body().data.room, `site-${org.id}-operator`)
    })

    test('hak tonton per peran: token & daftar hanya untuk peran yang boleh ditonton', async ({
        client,
        assert,
    }) => {
        const [org] = await db
            .table('organizations')
            .insert({
                name: `Site Tonton ${randomBytes(3).toString('hex')}`,
                type: 'company_asset',
                unique_site_code: `UJI-${randomBytes(4).toString('hex').toUpperCase()}`,
                is_active: true,
                created_at: new Date(),
                updated_at: new Date(),
            })
            .returning(['id'])
        const staff = await staffIn(org.id)
        // Pengawas site yang hanya boleh menonton peran "operator" (bukan staff_viewer).
        await db.table('roles').insert({
            name: 'pengawas_operator',
            guard_name: 'web',
            label: 'Pengawas operator',
            site_scope: 'own',
            watchable_roles: JSON.stringify(['operator']),
        })
        const permissionIds = await db
            .from('permissions')
            .whereIn('name', ['live.watch', 'live.roster'])
            .select('id')
        const pengawasRole = await db.from('roles').where('name', 'pengawas_operator').firstOrFail()
        await db
            .table('role_has_permissions')
            .multiInsert(
                permissionIds.map((row) => ({ role_id: pengawasRole.id, permission_id: row.id }))
            )
        const pengawas = await staffIn(org.id, 'pengawas_operator')
        const bearer = await loginToken(pengawas, DateTime.now().plus({ hours: 2 }))

        const forbiddenRole = await client
            .post('/api/v1/live/watch-token')
            .json({ organization_id: org.id, role: 'staff_viewer' })
            .bearerToken(bearer)
        forbiddenRole.assertStatus(403)

        const allowedRole = await client
            .post('/api/v1/live/watch-token')
            .json({ organization_id: org.id, role: 'operator' })
            .bearerToken(bearer)
        allowedRole.assertStatus(200)
        assert.equal(allowedRole.body().data.room, `site-${org.id}-operator`)

        // Staf (staff_viewer) tidak muncul di daftar milik pengawas ini.
        const list = await client
            .get('/api/v1/live/sessions')
            .qs({ organization_id: org.id })
            .bearerToken(bearer)
        list.assertStatus(200)
        const ids = list.body().data.roster.map((member: { user_id: number }) => member.user_id)
        assert.notInclude(ids, staff)
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

    test('Ruang pusat bisa ditonton admin, tidak bisa oleh leader atau staf', async ({
        client,
    }) => {
        const admin = await userWithRole('admin')
        const allowed = await client
            .post('/api/v1/live/watch-token')
            .json({ central: true, role: 'leader' })
            .bearerToken(admin.bearer)
        allowed.assertStatus(200)
        allowed.assertBodyContains({ data: { room: 'pusat-leader' } })

        const leader = await userWithRole('leader')
        const leaderDenied = await client
            .post('/api/v1/live/watch-token')
            .json({ central: true, role: 'leader' })
            .bearerToken(leader.bearer)
        leaderDenied.assertStatus(403)

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
            .json({ central: true, role: 'leader' })
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
