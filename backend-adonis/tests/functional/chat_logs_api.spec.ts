import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import testUtils from '@adonisjs/core/services/test_utils'
import PersonalAccessToken from '#models/personal_access_token'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'
import { chatImagesDiskName, disk } from '#services/storage'
import { QUEUE_HEARTBEAT_KEY, SCHEDULER_HEARTBEAT_KEY } from '#services/server_status'

/**
 * Padanan tests/Feature/ChatMessageTest, ActivityLogTest, dan SystemStatusTest
 * di backend-api. Butuh database tes Laravel yang sudah di-seed
 * RolesAndPermissionsSeeder (peran & izin dibaca dari tabel spatie).
 */

async function organization(name = 'Site Uji') {
    const [row] = await db
        .table('organizations')
        .insert({
            name,
            unique_site_code: `UJI-${randomBytes(4).toString('hex')}`,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id', 'name'])
    return row as { id: number; name: string }
}

async function userWithRole(role: string, organizationId: number | null = null) {
    const suffix = randomBytes(4).toString('hex')
    const [user] = await db
        .table('users')
        .insert({
            username: `uji.${suffix}`,
            name: `Uji ${suffix}`,
            email: `uji.${suffix}@example.test`,
            password: '$2y$10$Y18XUtkwVNaSkDxG0mGKX.51ec8i1y3rdvE4Cc.QSg9izFzIo/CiO',
            organization_id: organizationId,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id', 'name', 'username'])

    const roleRow = await db.from('roles').where('name', role).firstOrFail()
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

    return {
        id: user.id as number,
        name: user.name as string,
        username: user.username as string,
        bearer: `${token.id}|${plain}`,
    }
}

async function newOrganizationId() {
    const created = await organization()
    return created.id
}

async function bearerFor(role: string, organizationIdValue: number | null = null) {
    const user = await userWithRole(role, organizationIdValue)
    return user.bearer
}

async function userIdWithRole(role: string, organizationIdValue: number | null = null) {
    const user = await userWithRole(role, organizationIdValue)
    return user.id
}

async function chatMessage(organizationId: number, userId: number, body: string) {
    const [row] = await db
        .table('chat_messages')
        .insert({
            organization_id: organizationId,
            user_id: userId,
            body,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning('id')
    return row.id as number
}

/** PNG 800x600 minimal (signature + IHDR) -- cukup untuk sniffing isi berkas. */
function png(width: number, height: number) {
    const buffer = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
    buffer.writeUInt32BE(13, 8)
    buffer.write('IHDR', 12, 'latin1')
    buffer.writeUInt32BE(width, 16)
    buffer.writeUInt32BE(height, 20)
    return buffer
}

test.group('Chat staf per site', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('staf chat di site sendiri dan saling melihat', async ({ client, assert }) => {
        const org = await organization()
        const budi = await userWithRole('staff_viewer', org.id)
        const sari = await userWithRole('staff_viewer', org.id)

        const sent = await client
            .post('/api/v1/chat/messages')
            .bearerToken(budi.bearer)
            .json({ body: '  Halo tim, rapat jam 3  ' })
        sent.assertStatus(201)
        sent.assertBodyContains({
            data: { organization_id: org.id, user_name: budi.name, body: 'Halo tim, rapat jam 3' },
        })

        const history = await client.get('/api/v1/chat/messages').bearerToken(sari.bearer)
        history.assertStatus(200)
        assert.lengthOf(history.body().data.messages, 1)
        assert.equal(history.body().data.messages[0].body, 'Halo tim, rapat jam 3')
    })

    test('staf tidak bisa membaca atau menulis chat site lain', async ({ client, assert }) => {
        const staffA = await userWithRole('staff_viewer', await newOrganizationId())
        const orgB = await organization()
        const staffB = await userWithRole('staff_viewer', orgB.id)
        await chatMessage(orgB.id, staffB.id, 'rahasia site B')

        const read = await client
            .get(`/api/v1/chat/messages?organization_id=${orgB.id}`)
            .bearerToken(staffA.bearer)
        read.assertStatus(403)

        const write = await client
            .post('/api/v1/chat/messages')
            .bearerToken(staffA.bearer)
            .json({ organization_id: orgB.id, body: 'masuk' })
        write.assertStatus(403)

        const count = await db
            .from('chat_messages')
            .where('organization_id', orgB.id)
            .count('* as total')
        assert.equal(Number(count[0].total), 1)
    })

    test('pesan kosong atau terlalu panjang ditolak', async ({ client }) => {
        const staff = await userWithRole('staff_viewer', await newOrganizationId())

        const empty = await client
            .post('/api/v1/chat/messages')
            .bearerToken(staff.bearer)
            .json({ body: '   ' })
        empty.assertStatus(422)
        empty.assertBodyContains({ message: 'Pesan tidak boleh kosong' })

        const long = await client
            .post('/api/v1/chat/messages')
            .bearerToken(staff.bearer)
            .json({ body: 'a'.repeat(1001) })
        long.assertStatus(422)
        long.assertBodyContains({
            errors: { body: ['The body field must not be greater than 1000 characters.'] },
        })
    })

    test('riwayat dipaginasi, urut lama ke baru', async ({ client, assert }) => {
        const org = await organization()
        const staff = await userWithRole('staff_viewer', org.id)
        for (let number = 1; number <= 55; number++) {
            await chatMessage(org.id, staff.id, `pesan ${number}`)
        }

        const latest = await client.get('/api/v1/chat/messages').bearerToken(staff.bearer)
        const messages = latest.body().data.messages
        assert.lengthOf(messages, 50)
        assert.equal(messages[0].body, 'pesan 6')
        assert.equal(messages[49].body, 'pesan 55')
        assert.isTrue(latest.body().data.has_more)

        const older = await client
            .get(`/api/v1/chat/messages?before_id=${messages[0].id}`)
            .bearerToken(staff.bearer)
        assert.deepEqual(
            older.body().data.messages.map((message: { body: string }) => message.body),
            ['pesan 1', 'pesan 2', 'pesan 3', 'pesan 4', 'pesan 5']
        )
        assert.isFalse(older.body().data.has_more)
    })

    test('gambar hanya bisa dibuka lewat tautan bertanda tangan', async ({ client, assert }) => {
        const org = await organization()
        const budi = await userWithRole('staff_viewer', org.id)

        const sent = await client
            .post('/api/v1/chat/messages')
            .bearerToken(budi.bearer)
            .field('body', 'Bukti packing')
            .file('image', png(800, 600), { filename: 'packing.png' })
        sent.assertStatus(201)
        const data = sent.body().data
        assert.equal(data.body, 'Bukti packing')
        assert.deepInclude(data.image, { width: 800, height: 600 })
        assert.notProperty(data, 'image_path')

        const row = await db.from('chat_messages').where('id', data.id).firstOrFail()
        assert.isTrue(row.image_path.startsWith(`chat/${org.id}/`))

        if (chatImagesDiskName() === 'local') {
            const url = new URL(data.image.url)
            const image = await client.get(url.pathname + url.search)
            image.assertStatus(200)
            image.assertHeader('content-type', 'image/png')
            image.assertHeader('x-content-type-options', 'nosniff')
        }

        const unsigned = await client.get(`/api/v1/chat-messages/${data.id}/image`)
        unsigned.assertStatus(403)

        await disk(chatImagesDiskName()).delete(row.image_path)
    })

    test('SVG ditolak', async ({ client }) => {
        const budi = await userWithRole('staff_viewer', await newOrganizationId())

        const svg = await client
            .post('/api/v1/chat/messages')
            .bearerToken(budi.bearer)
            .file(
                'image',
                Buffer.from(
                    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
                ),
                { filename: 'x.svg' }
            )
        svg.assertStatus(422)
    })

    test('balasan mengutip pesan asal di site yang sama saja', async ({ client }) => {
        const org = await organization()
        const budi = await userWithRole('staff_viewer', org.id)
        const sari = await userWithRole('staff_viewer', org.id)
        const original = await chatMessage(org.id, budi.id, 'Siapa yang pegang kunci gudang?')

        const reply = await client
            .post('/api/v1/chat/messages')
            .bearerToken(sari.bearer)
            .json({ body: 'Saya', reply_to_id: original })
        reply.assertStatus(201)
        reply.assertBodyContains({
            data: {
                reply_to: {
                    id: original,
                    user_name: budi.name,
                    body: 'Siapa yang pegang kunci gudang?',
                    has_image: false,
                },
            },
        })

        const orgB = await organization()
        const secret = await chatMessage(
            orgB.id,
            await userIdWithRole('staff_viewer', orgB.id),
            'rahasia site B'
        )
        const peek = await client
            .post('/api/v1/chat/messages')
            .bearerToken(sari.bearer)
            .json({ body: 'intip', reply_to_id: secret })
        peek.assertStatus(422)
    })

    test('satu pesan hanya terlihat oleh site-nya', async ({ client }) => {
        const org = await organization()
        const id = await chatMessage(org.id, await userIdWithRole('staff_viewer', org.id), 'halo')

        const own = await client
            .get(`/api/v1/chat/messages/${id}`)
            .bearerToken(await bearerFor('staff_viewer', org.id))
        own.assertStatus(200)
        own.assertBodyContains({ data: { body: 'halo' } })

        const outsider = await bearerFor('staff_viewer', await newOrganizationId())
        const other = await client.get(`/api/v1/chat/messages/${id}`).bearerToken(outsider)
        other.assertStatus(403)
    })
})

test.group('Log aktivitas', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('admin site hanya melihat site sendiri; staf tidak bisa membuka log', async ({
        client,
    }) => {
        const orgA = await organization()
        const orgB = await organization()
        const adminA = await userWithRole('site_admin', orgA.id)

        const foreign = await client
            .get(`/api/v1/activity-logs?organization_id=${orgB.id}`)
            .bearerToken(adminA.bearer)
        foreign.assertStatus(403)
        foreign.assertBodyContains({ message: 'Anda tidak berwenang melihat log site ini' })

        const staff = await client
            .get('/api/v1/activity-logs')
            .bearerToken(await bearerFor('staff_viewer', orgA.id))
        staff.assertStatus(403)
    })

    test('catatan API tampil dengan pelaku, site, perangkat, dan rincian perubahan', async ({
        client,
        assert,
    }) => {
        const org = await organization('Gudang Utama')
        const actor = await userWithRole('site_admin', org.id)
        const batch = '6f1f7c1e-9a51-4d1e-9a6b-1f2f3f4f5f6f'
        const common = {
            causer_type: LARAVEL_USER_MORPH,
            causer_id: actor.id,
            subject_type: 'App\\Models\\Device',
            subject_id: 999_999,
            batch_uuid: batch,
            organization_id: org.id,
            ip_address: '10.0.0.5',
            created_at: new Date(),
            updated_at: new Date(),
        }
        await db.table('activity_log').insert([
            {
                ...common,
                log_name: 'api',
                description: 'Mengubah device HP Kasir',
                event: 'DeviceController@update',
                user_agent:
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
                properties: JSON.stringify({
                    category: 'device',
                    status: 200,
                    result: 'ok',
                    message: null,
                    input: { device_name: 'HP Kasir Depan' },
                    route: 'PUT /api/v1/devices/999999',
                }),
            },
            {
                ...common,
                log_name: 'default',
                description: 'updated',
                event: 'updated',
                user_agent: null,
                properties: JSON.stringify({
                    attributes: { device_name: 'HP Kasir Depan' },
                    old: { device_name: 'HP Kasir' },
                }),
            },
        ])

        const response = await client
            .get('/api/v1/activity-logs')
            .bearerToken(await bearerFor('super_admin'))
        response.assertStatus(200)
        const entry = response
            .body()
            .data.entries.find((item: { category: string }) => item.category === 'device')

        assert.equal(entry.description, 'Mengubah device HP Kasir')
        assert.equal(entry.causer.id, actor.id)
        assert.equal(entry.organization.name, 'Gudang Utama')
        assert.equal(entry.device, 'Chrome · Windows')
        assert.deepEqual(entry.changes[0].fields, [
            { field: 'device_name', old: 'HP Kasir', new: 'HP Kasir Depan' },
        ])
    })

    test('login gagal & berhasil dicatat tanpa password', async ({ client, assert }) => {
        const staff = await userWithRole('staff_viewer', await newOrganizationId())

        // Kata sandi fixture user: "password".
        await client
            .post('/api/v1/auth/login')
            .json({ username: staff.username, password: 'salah' })

        const rows = await db
            .from('activity_log')
            .where('log_name', 'api')
            .where('event', 'AuthController@login')
        assert.isAbove(rows.length, 0)
        const failed = rows.find((row) => row.properties.result === 'denied')
        assert.isNull(failed.causer_id)
        assert.equal(failed.subject_id, staff.id)
        assert.notInclude(JSON.stringify(rows), '"salah"')
    }).skip(
        true,
        'Butuh AuthController@login (modul auth) & middleware log API terdaftar di start/kernel.ts'
    )
})

test.group('Status server', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())
    group.each.teardown(async () => {
        await redis.del(SCHEDULER_HEARTBEAT_KEY, QUEUE_HEARTBEAT_KEY)
    })

    test('hanya super_admin yang boleh melihat status server', async ({ client }) => {
        for (const role of ['staff_viewer', 'site_admin', 'admin', 'leader']) {
            const response = await client
                .get('/api/v1/system/status')
                .bearerToken(await bearerFor(role))
            response.assertStatus(403)
        }
    })

    test('scheduler & antrean dinilai dari detak terakhirnya', async ({ client, assert }) => {
        const admin = await userWithRole('super_admin')
        const services = async () => {
            const response = await client.get('/api/v1/system/status').bearerToken(admin.bearer)
            response.assertStatus(200)
            return Object.fromEntries(
                response
                    .body()
                    .data.services.map((service: { key: string }) => [service.key, service])
            )
        }

        await redis.del(SCHEDULER_HEARTBEAT_KEY, QUEUE_HEARTBEAT_KEY)
        let byKey = await services()
        assert.equal(byKey.scheduler.status, 'unknown')
        assert.equal(byKey.queue.status, 'unknown')
        assert.equal(byKey.api.status, 'ok')
        assert.equal(byKey.database.status, 'ok')
        assert.equal(byKey.cache.status, 'ok')

        const now = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')
        await redis.set(SCHEDULER_HEARTBEAT_KEY, now)
        await redis.set(QUEUE_HEARTBEAT_KEY, now)
        byKey = await services()
        assert.equal(byKey.scheduler.status, 'ok')
        assert.equal(byKey.queue.status, 'ok')
        assert.equal(byKey.scheduler.last_seen_at, now)

        const sixMinutesAgo = new Date(Date.now() - 6 * 60_000).toISOString()
        await redis.set(SCHEDULER_HEARTBEAT_KEY, sixMinutesAgo)
        byKey = await services()
        assert.equal(byKey.scheduler.status, 'warn')
    })
})
