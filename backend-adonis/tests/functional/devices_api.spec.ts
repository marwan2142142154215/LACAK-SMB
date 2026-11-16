import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import PersonalAccessToken from '#models/PersonalAccessToken'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'
import { DEVICE_MORPH } from '#services/DeviceResource'

/**
 * Padanan tests/Feature/DeviceCommandAuthorizationTest.php di backend-api,
 * ditambah alur OTP, klaim/daftar ulang, dan CRUD device. Memakai database
 * tes yang sama dengan backend-api (skema dari migrasi Laravel).
 */

const SITE_ADMIN_PERMISSIONS = [
    'devices.view',
    'devices.manage',
    'devices.lock',
    'devices.unlock',
    'devices.locate',
    'devices.monitor',
    'radar.view',
]

/** Role::firstOrCreate + syncPermissions seperti RolesAndPermissionsSeeder. */
async function ensureRole(name: string, permissions: string[]) {
    const now = new Date()
    let role = await db.from('roles').where({ name, guard_name: 'web' }).first()
    if (!role) {
        ;[role] = await db
            .table('roles')
            .insert({ name, guard_name: 'web', created_at: now, updated_at: now })
            .returning(['id'])
    }
    for (const permissionName of permissions) {
        let permission = await db
            .from('permissions')
            .where({ name: permissionName, guard_name: 'web' })
            .first()
        if (!permission) {
            ;[permission] = await db
                .table('permissions')
                .insert({
                    name: permissionName,
                    guard_name: 'web',
                    created_at: now,
                    updated_at: now,
                })
                .returning(['id'])
        }
        await db
            .table('role_has_permissions')
            .insert({ role_id: role.id, permission_id: permission.id })
            .onConflict(['permission_id', 'role_id'])
            .ignore()
    }
    return role.id as number
}

async function makeOrganization() {
    const suffix = randomBytes(4).toString('hex')
    const [org] = await db
        .table('organizations')
        .insert({
            name: `Site ${suffix}`,
            unique_site_code: `S${suffix}`,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])
    return org.id as number
}

async function makeUser(organizationId: number | null, role: string | null) {
    const suffix = randomBytes(4).toString('hex')
    const [user] = await db
        .table('users')
        .insert({
            username: `uji.device.${suffix}`,
            name: 'Uji Device',
            email: `uji.device.${suffix}@example.test`,
            password: '$2y$10$Y18XUtkwVNaSkDxG0mGKX.51ec8i1y3rdvE4Cc.QSg9izFzIo/CiO',
            organization_id: organizationId,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])

    if (role) {
        const permissions =
            role === 'site_admin'
                ? SITE_ADMIN_PERMISSIONS
                : role === 'super_admin'
                  ? SITE_ADMIN_PERMISSIONS
                  : ['devices.view']
        const roleId = await ensureRole(role, permissions)
        await db
            .table('model_has_roles')
            .insert({ role_id: roleId, model_type: LARAVEL_USER_MORPH, model_id: user.id })
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

async function makeDevice(organizationId: number, values: Record<string, unknown> = {}) {
    const [device] = await db
        .table('devices')
        .insert({
            organization_id: organizationId,
            device_name: 'HP Kasir',
            device_uuid: `uuid-${randomBytes(8).toString('hex')}`,
            android_version: '14',
            app_build_version: '1.0.0',
            site_code_embedded: 'SITE',
            status: 'online',
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
            ...values,
        })
        .returning(['id', 'device_uuid'])
    return device as { id: number; device_uuid: string }
}

async function statusOf(deviceId: number): Promise<string> {
    const row = await db.from('devices').where('id', deviceId).first()
    return row.status
}

test.group('Device: otorisasi perintah (DeviceCommandAuthorizationTest)', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('site_admin bisa lock device milik org sendiri', async ({ client, assert }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org)
        const admin = await makeUser(org, 'site_admin')

        const response = await client
            .post(`/api/v1/devices/${device.id}/commands`)
            .bearerToken(admin.bearer)
            .json({ command_type: 'lock', issued_via: 'web_dashboard' })

        response.assertStatus(201)
        response.assertBodyContains({
            success: true,
            message: 'Perintah berhasil dikirim, menunggu diterima device',
            data: {
                device_id: device.id,
                command_type: 'lock',
                status: 'pending',
                issued_by: admin.id,
            },
        })
        assert.equal(await statusOf(device.id), 'locked')

        const log = await db
            .from('activity_log')
            .where({ subject_type: DEVICE_MORPH, subject_id: device.id, event: 'updated' })
            .first()
        assert.deepEqual(log.properties, {
            attributes: { status: 'locked' },
            old: { status: 'online' },
        })
    })

    test('site_admin TIDAK BISA lock device milik org lain', async ({ client, assert }) => {
        const orgA = await makeOrganization()
        const orgB = await makeOrganization()
        const deviceOfOrgB = await makeDevice(orgB)
        const adminOfOrgA = await makeUser(orgA, 'site_admin')

        const response = await client
            .post(`/api/v1/devices/${deviceOfOrgB.id}/commands`)
            .bearerToken(adminOfOrgA.bearer)
            .json({ command_type: 'lock', issued_via: 'web_dashboard' })

        response.assertStatus(403)
        response.assertBodyContains({
            success: false,
            message: 'Anda tidak berwenang mengirim perintah ke device ini',
        })
        assert.notEqual(await statusOf(deviceOfOrgB.id), 'locked')
    })

    test('super_admin bisa lock device site mana pun', async ({ client }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org)
        const superAdmin = await makeUser(null, 'super_admin')

        const response = await client
            .post(`/api/v1/devices/${device.id}/commands`)
            .bearerToken(superAdmin.bearer)
            .json({ command_type: 'lock', issued_via: 'web_dashboard' })

        response.assertStatus(201)
    })

    test('staff_viewer (view-only) tidak bisa lock device sama sekali', async ({ client }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org)
        const viewer = await makeUser(org, 'staff_viewer')

        const response = await client
            .post(`/api/v1/devices/${device.id}/commands`)
            .bearerToken(viewer.bearer)
            .json({ command_type: 'lock', issued_via: 'web_dashboard' })

        response.assertStatus(403)
        response.assertBodyContains({ message: 'Anda tidak berwenang melakukan tindakan ini' })
    })

    test('perintah lock & unlock tidak lagi butuh dokumen consent', async ({ client }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org, { status: 'online' })
        const admin = await makeUser(org, 'site_admin')

        const lock = await client
            .post(`/api/v1/devices/${device.id}/commands`)
            .bearerToken(admin.bearer)
            .json({ command_type: 'lock', issued_via: 'web_dashboard' })
        lock.assertStatus(201)

        const unlock = await client
            .post(`/api/v1/devices/${device.id}/commands`)
            .bearerToken(admin.bearer)
            .json({ command_type: 'unlock', issued_via: 'web_dashboard' })
        unlock.assertStatus(201)
    })

    test('issued_via system_auto ditolak validasi', async ({ client }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org)
        const admin = await makeUser(org, 'site_admin')

        const response = await client
            .post(`/api/v1/devices/${device.id}/commands`)
            .bearerToken(admin.bearer)
            .json({ command_type: 'lock', issued_via: 'system_auto' })

        response.assertStatus(422)
        response.assertBodyContains({
            success: false,
            message: 'Isian tidak lolos validasi',
            errors: { issued_via: ['The selected issued via is invalid.'] },
        })
    })
})

test.group('Device: CRUD', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('daftar device hanya site sendiri, lengkap dengan nama site', async ({
        client,
        assert,
    }) => {
        const org = await makeOrganization()
        const other = await makeOrganization()
        const mine = await makeDevice(org)
        await makeDevice(other)
        const admin = await makeUser(org, 'site_admin')

        const response = await client.get('/api/v1/devices').bearerToken(admin.bearer)

        response.assertStatus(200)
        const body = response.body()
        assert.equal(body.message, 'Daftar device')
        assert.equal(body.data.total, 1)
        assert.equal(body.data.items[0].id, mine.id)
        assert.property(body.data.items[0], 'organization_name')
        assert.isNull(body.data.items[0].latest_location)
        assert.notProperty(body.data.items[0], 'secret_hash')

        const forbidden = await client
            .get(`/api/v1/devices?organization_id=${other}`)
            .bearerToken(admin.bearer)
        forbidden.assertStatus(403)
        forbidden.assertBodyContains({ message: 'Anda tidak berwenang melihat device site ini' })
    })

    test('lokasi device hanya untuk pemegang radar.view: tanpa izin kuncinya tidak dikirim', async ({
        client,
        assert,
    }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org)
        await db.table('device_locations').insert({
            device_id: device.id,
            source: 'gps',
            latitude: '-6.2088000',
            longitude: '106.8456000',
            ble_distance_meters: '3.50',
            recorded_at: new Date(),
            created_at: new Date(),
        })
        const staff = await makeUser(org, 'staff_viewer')
        const admin = await makeUser(org, 'site_admin')

        // Tanpa radar.view (devices.view saja): daftar dan detail tidak memuat lokasi sama sekali.
        const staffList = await client.get('/api/v1/devices').bearerToken(staff.bearer)
        staffList.assertStatus(200)
        assert.lengthOf(staffList.body().data.items, 1)
        assert.notProperty(staffList.body().data.items[0], 'latest_location')
        assert.notInclude(JSON.stringify(staffList.body()), '106.8456')

        const staffDetail = await client
            .get(`/api/v1/devices/${device.id}`)
            .bearerToken(staff.bearer)
        staffDetail.assertStatus(200)
        assert.notProperty(staffDetail.body().data, 'latest_location')
        assert.notInclude(JSON.stringify(staffDetail.body()), '106.8456')

        // Dengan radar.view: lokasi ikut dikirim.
        const adminList = await client.get('/api/v1/devices').bearerToken(admin.bearer)
        assert.equal(adminList.body().data.items[0].latest_location.longitude, '106.8456000')
        const adminDetail = await client
            .get(`/api/v1/devices/${device.id}`)
            .bearerToken(admin.bearer)
        assert.equal(adminDetail.body().data.latest_location.latitude, '-6.2088000')
    })

    test('daftarkan device: status pending_enrollment + log created', async ({
        client,
        assert,
    }) => {
        const org = await makeOrganization()
        const admin = await makeUser(org, 'site_admin')

        const response = await client
            .post('/api/v1/devices')
            .bearerToken(admin.bearer)
            .json({
                organization_id: org,
                device_name: 'HP Gudang',
                device_uuid: `uuid-${randomBytes(6).toString('hex')}`,
                android_version: '14',
                app_build_version: '2.0.0',
                site_code_embedded: 'SITE',
            })

        response.assertStatus(201)
        const data = response.body().data
        assert.equal(data.status, 'pending_enrollment')
        assert.isTrue(data.is_active)
        assert.notProperty(data, 'organization_name')
        assert.notProperty(data, 'latest_location')
        assert.isNull(data.consent_document_id)

        const log = await db
            .from('activity_log')
            .where({ subject_type: DEVICE_MORPH, subject_id: data.id, event: 'created' })
            .first()
        assert.deepEqual(log.properties, {
            attributes: { device_name: 'HP Gudang', status: 'pending_enrollment', is_active: true },
        })
    })

    test('ubah nama device mencatat perubahan', async ({ client, assert }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org)
        const admin = await makeUser(org, 'site_admin')

        const response = await client
            .put(`/api/v1/devices/${device.id}`)
            .bearerToken(admin.bearer)
            .json({ device_name: 'HP Kasir Depan' })

        response.assertStatus(200)
        response.assertBodyContains({ data: { device_name: 'HP Kasir Depan' } })
        const log = await db
            .from('activity_log')
            .where({ subject_type: DEVICE_MORPH, subject_id: device.id, event: 'updated' })
            .first()
        assert.deepEqual(log.properties, {
            attributes: { device_name: 'HP Kasir Depan' },
            old: { device_name: 'HP Kasir' },
        })
    })

    test('hapus device = soft delete, lalu 404', async ({ client, assert }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org)
        const admin = await makeUser(org, 'site_admin')

        const response = await client
            .delete(`/api/v1/devices/${device.id}`)
            .bearerToken(admin.bearer)
        response.assertStatus(200)
        response.assertBodyContains({
            message: 'Device berhasil dihapus (soft delete)',
            data: null,
        })

        const row = await db.from('devices').where('id', device.id).first()
        assert.isNotNull(row.deleted_at)

        const show = await client.get(`/api/v1/devices/${device.id}`).bearerToken(admin.bearer)
        show.assertStatus(404)
        show.assertBodyContains({ message: 'Data tidak ditemukan' })
    })
})

test.group('Device: OTP & pendaftaran', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('OTP dibuat admin lalu diverifikasi APK -> device online', async ({ client, assert }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org, { status: 'locked' })
        const admin = await makeUser(org, 'site_admin')

        const generated = await client
            .post(`/api/v1/devices/${device.id}/otp`)
            .bearerToken(admin.bearer)
        generated.assertStatus(201)
        const { code, expires_at: expiresAt } = generated.body().data
        assert.match(code, /^\d{6}$/)
        assert.match(expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000000Z$/)

        const otp = await db.from('device_otps').where('device_id', device.id).first()
        assert.match(otp.otp_code_hash, /^\$2y\$12\$/)

        const wrong = await client.post('/api/v1/device-otp/verify').json({
            device_uuid: device.device_uuid,
            code: code === '111111' ? '222222' : '111111',
        })
        wrong.assertStatus(422)
        wrong.assertBodyContains({ message: 'Kode OTP salah atau sudah kedaluwarsa' })

        const right = await client
            .post('/api/v1/device-otp/verify')
            .json({ device_uuid: device.device_uuid, code })
        right.assertStatus(200)
        right.assertBodyContains({ success: true, message: 'OTP benar, device dibuka', data: null })
        assert.equal(await statusOf(device.id), 'online')
    })

    test('kode lepas: admin buat, APK verifikasi -> device dilepas (is_active false, released_at)', async ({
        client,
        assert,
    }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org)
        const admin = await makeUser(org, 'site_admin')

        const generated = await client
            .post(`/api/v1/devices/${device.id}/otp`)
            .bearerToken(admin.bearer)
            .json({ purpose: 'release' })
        generated.assertStatus(201)
        generated.assertBodyContains({ success: true, data: { purpose: 'release' } })
        assert.match(generated.body().message, /^Kode lepas perangkat dibuat/)
        const { code } = generated.body().data
        assert.match(code, /^\d{6}$/)

        const otp = await db
            .from('device_otps')
            .where({ device_id: device.id, purpose: 'release' })
            .first()
        assert.isNotNull(otp)

        // Pembuatan kode lepas tercatat (membuka jalan menghapus aplikasi).
        const issuedLog = await db
            .from('activity_log')
            .where({
                subject_type: DEVICE_MORPH,
                subject_id: device.id,
                event: 'release_code_issued',
            })
            .first()
        assert.isNotNull(issuedLog)

        // Kode lepas tidak bisa dipakai di endpoint buka kunci biasa (purpose beda).
        const wrongEndpoint = await client
            .post('/api/v1/device-otp/verify')
            .json({ device_uuid: device.device_uuid, code })
        wrongEndpoint.assertStatus(422)

        const released = await client
            .post('/api/v1/device-otp/release')
            .json({ device_uuid: device.device_uuid, code })
        released.assertStatus(200)
        released.assertBodyContains({
            success: true,
            message: 'Kode benar, perangkat dilepas. Aplikasi sekarang bisa dihapus dari HP.',
        })

        const row = await db.from('devices').where('id', device.id).first()
        assert.isFalse(Boolean(row.is_active))
        assert.isNotNull(row.released_at)

        // Perubahan is_active true->false tercatat di activity_log.
        const updatedLog = await db
            .from('activity_log')
            .where({ subject_type: DEVICE_MORPH, subject_id: device.id, event: 'updated' })
            .orderBy('id', 'desc')
            .first()
        assert.deepEqual(updatedLog.properties, {
            attributes: { is_active: false },
            old: { is_active: true },
        })
    })

    test('membuat kode lepas butuh izin devices.manage', async ({ client }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org)
        const viewer = await makeUser(org, 'operator') // hanya devices.view

        const response = await client
            .post(`/api/v1/devices/${device.id}/otp`)
            .bearerToken(viewer.bearer)
            .json({ purpose: 'release' })
        response.assertStatus(403)
        response.assertBodyContains({ message: 'Anda tidak berwenang melakukan tindakan ini' })
    })

    test('klaim hanya sekali; rahasia tersimpan sebagai SHA-256', async ({ client, assert }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org, { status: 'pending_enrollment' })

        const first = await client
            .post('/api/v1/device-enrollments/claim')
            .json({ device_uuid: device.device_uuid })
        first.assertStatus(200)
        const secret = first.body().data.device_secret as string
        assert.match(secret, /^[0-9a-f]{64}$/)

        const row = await db.from('devices').where('id', device.id).first()
        assert.equal(row.secret_hash, createHash('sha256').update(secret).digest('hex'))

        const second = await client
            .post('/api/v1/device-enrollments/claim')
            .json({ device_uuid: device.device_uuid })
        second.assertStatus(404)
        second.assertBodyContains({
            message:
                'Device belum didaftarkan admin atau perlu didaftarkan ulang. Hubungi admin site.',
        })
    })

    test('daftar ulang ditolak saat device terkunci', async ({ client, assert }) => {
        const org = await makeOrganization()
        const locked = await makeDevice(org, { status: 'locked', secret_hash: 'x' })
        const online = await makeDevice(org, { status: 'online', secret_hash: 'x' })
        const admin = await makeUser(org, 'site_admin')

        const rejected = await client
            .post(`/api/v1/devices/${locked.id}/re-enroll`)
            .bearerToken(admin.bearer)
        rejected.assertStatus(422)

        const accepted = await client
            .post(`/api/v1/devices/${online.id}/re-enroll`)
            .bearerToken(admin.bearer)
        accepted.assertStatus(200)
        const row = await db.from('devices').where('id', online.id).first()
        assert.isNull(row.secret_hash)
        assert.equal(row.status, 'pending_enrollment')
    })
})

test.group('Device: pindah site', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('super_admin memindahkan device ke site lain; site_code_embedded tetap', async ({
        client,
        assert,
    }) => {
        const asal = await makeOrganization()
        const tujuan = await makeOrganization()
        const superAdmin = await makeUser(null, 'super_admin')
        const device = await makeDevice(asal, { site_code_embedded: 'KODE-ASAL' })

        const moved = await client
            .put(`/api/v1/devices/${device.id}/site`)
            .json({ organization_id: tujuan })
            .bearerToken(superAdmin.bearer)
        moved.assertStatus(200)

        const row = await db.from('devices').where('id', device.id).first()
        assert.equal(Number(row.organization_id), tujuan)
        // Kode APK yang tertanam tidak berubah -> device tetap bisa terhubung.
        assert.equal(row.site_code_embedded, 'KODE-ASAL')
    })

    test('tidak bisa memindahkan ke site yang sama', async ({ client }) => {
        const org = await makeOrganization()
        const superAdmin = await makeUser(null, 'super_admin')
        const device = await makeDevice(org)
        const res = await client
            .put(`/api/v1/devices/${device.id}/site`)
            .json({ organization_id: org })
            .bearerToken(superAdmin.bearer)
        res.assertStatus(422)
    })

    test('admin site tidak bisa memindahkan ke site yang tidak dikelola', async ({ client }) => {
        const asal = await makeOrganization()
        const tujuan = await makeOrganization()
        const admin = await makeUser(asal, 'site_admin')
        const device = await makeDevice(asal)
        const res = await client
            .put(`/api/v1/devices/${device.id}/site`)
            .json({ organization_id: tujuan })
            .bearerToken(admin.bearer)
        res.assertStatus(403)
    })

    test('staf tidak bisa memindahkan device', async ({ client }) => {
        const asal = await makeOrganization()
        const tujuan = await makeOrganization()
        const staff = await makeUser(asal, 'staff_viewer')
        const device = await makeDevice(asal)
        const res = await client
            .put(`/api/v1/devices/${device.id}/site`)
            .json({ organization_id: tujuan })
            .bearerToken(staff.bearer)
        res.assertStatus(403)
    })
})

test.group('Device: detail perangkat & status perintah', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('detail perangkat dari APK & perintah terakhir ikut di daftar dan detail', async ({
        client,
        assert,
    }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org, {
            manufacturer: 'samsung',
            model: 'SM-A155F',
            is_charging: true,
            network_type: 'cellular',
            carrier_name: 'Telkomsel',
            storage_free_mb: 2048,
            storage_total_mb: 65536,
            permission_state: JSON.stringify({ location: true, backgroundLocation: false }),
            info_updated_at: new Date(),
        })
        const admin = await makeUser(org, 'site_admin')
        await db.table('device_commands').insert([
            {
                device_id: device.id,
                command_type: 'locate_now',
                issued_by: admin.id,
                issued_via: 'web_dashboard',
                status: 'expired',
                result_message: 'HP tidak terhubung dalam 10 menit, permintaan lokasi dibatalkan',
                created_at: new Date(Date.now() - 60_000),
            },
            {
                device_id: device.id,
                command_type: 'lock',
                issued_by: admin.id,
                issued_via: 'web_dashboard',
                status: 'executed',
                delivered_at: new Date(),
                executed_at: new Date(),
                delivery_attempts: 2,
                result_message: 'Layar kunci tampil',
                created_at: new Date(),
            },
        ])

        const list = await client.get('/api/v1/devices').bearerToken(admin.bearer)
        list.assertStatus(200)
        const item = list.body().data.items[0]
        assert.equal(item.model, 'SM-A155F')
        assert.equal(item.carrier_name, 'Telkomsel')
        assert.deepEqual(item.permission_state, { location: true, backgroundLocation: false })
        assert.equal(item.latest_command.command_type, 'lock')
        assert.equal(item.latest_command.status, 'executed')
        assert.equal(item.latest_command.delivery_attempts, 2)
        assert.equal(item.latest_command.result_message, 'Layar kunci tampil')

        const detail = await client.get(`/api/v1/devices/${device.id}`).bearerToken(admin.bearer)
        assert.equal(detail.body().data.latest_command.status, 'executed')

        const history = await client
            .get(`/api/v1/devices/${device.id}/commands`)
            .bearerToken(admin.bearer)
        assert.deepEqual(
            history.body().data.items.map((command: { status: string }) => command.status),
            ['executed', 'expired']
        )
    })

    test('lokasi membawa akurasi, sumber, dan waktu fix', async ({ client, assert }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org)
        await db.table('device_locations').insert({
            device_id: device.id,
            source: 'gps',
            latitude: '-6.2088000',
            longitude: '106.8456000',
            accuracy_meters: '12.50',
            location_provider: 'gps',
            fixed_at: new Date('2026-11-15T03:00:00Z'),
            recorded_at: new Date(),
            created_at: new Date(),
        })
        const admin = await makeUser(org, 'site_admin')

        const detail = await client.get(`/api/v1/devices/${device.id}`).bearerToken(admin.bearer)
        assert.equal(detail.body().data.latest_location.accuracy_meters, '12.50')
        assert.equal(detail.body().data.latest_location.location_provider, 'gps')
        assert.isNotNull(detail.body().data.latest_location.fixed_at)
    })

    test('perintah ke HP offline tetap disimpan dengan pesan yang jelas', async ({ client }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org, { status: 'offline' })
        const admin = await makeUser(org, 'site_admin')

        const response = await client
            .post(`/api/v1/devices/${device.id}/commands`)
            .bearerToken(admin.bearer)
            .json({ command_type: 'lock', issued_via: 'web_dashboard' })

        response.assertStatus(201)
        response.assertBodyContains({
            message:
                'Perintah disimpan. HP sedang offline, perintah terkirim otomatis begitu HP terhubung lagi',
            data: { status: 'pending', delivery_attempts: 0, executed_at: null },
        })
    })
})
