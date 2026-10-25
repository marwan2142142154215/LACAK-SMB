import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import PersonalAccessToken from '#models/personal_access_token'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'
import { DEVICE_MORPH } from '#services/device_resource'

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

async function makeConsent(organizationId: number, createdBy: number, revoked = false) {
    const [consent] = await db
        .table('consent_documents')
        .insert({
            organization_id: organizationId,
            subject_name: 'Subjek',
            signer_name: 'Penanda Tangan',
            signer_role: 'pemilik',
            document_file_path: `consent-documents/${randomBytes(8).toString('hex')}.pdf`,
            signed_at: new Date(Date.now() - 86_400_000),
            valid_until: null,
            revoked_at: revoked ? new Date() : null,
            created_by: createdBy,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])
    return consent.id as number
}

async function makeDevice(
    organizationId: number,
    overrides: Record<string, unknown> & { revokedConsent?: boolean } = {}
) {
    const { revokedConsent, ...values } = overrides
    const owner = await makeUser(organizationId, null)
    const consentId = await makeConsent(organizationId, owner.id, revokedConsent)
    const [device] = await db
        .table('devices')
        .insert({
            organization_id: organizationId,
            consent_document_id: consentId,
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
        .returning(['id', 'device_uuid', 'consent_document_id'])
    return device as { id: number; device_uuid: string; consent_document_id: number }
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

    test('unlock tetap diizinkan walau consent sudah dicabut, lock tidak', async ({ client }) => {
        const org = await makeOrganization()
        const device = await makeDevice(org, { status: 'locked', revokedConsent: true })
        const admin = await makeUser(org, 'site_admin')

        const lock = await client
            .post(`/api/v1/devices/${device.id}/commands`)
            .bearerToken(admin.bearer)
            .json({ command_type: 'lock', issued_via: 'web_dashboard' })
        lock.assertStatus(422)

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

    test('daftarkan device: status pending_enrollment + log created', async ({
        client,
        assert,
    }) => {
        const org = await makeOrganization()
        const admin = await makeUser(org, 'site_admin')
        const consentId = await makeConsent(org, admin.id)

        const response = await client
            .post('/api/v1/devices')
            .bearerToken(admin.bearer)
            .json({
                organization_id: org,
                consent_document_id: consentId,
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

        const log = await db
            .from('activity_log')
            .where({ subject_type: DEVICE_MORPH, subject_id: data.id, event: 'created' })
            .first()
        assert.deepEqual(log.properties, {
            attributes: { device_name: 'HP Gudang', status: 'pending_enrollment', is_active: true },
        })
    })

    test('consent site lain ditolak 422', async ({ client }) => {
        const org = await makeOrganization()
        const other = await makeOrganization()
        const admin = await makeUser(org, 'site_admin')
        const consentOther = await makeConsent(other, admin.id)

        const response = await client
            .post('/api/v1/devices')
            .bearerToken(admin.bearer)
            .json({
                organization_id: org,
                consent_document_id: consentOther,
                device_name: 'HP',
                device_uuid: `uuid-${randomBytes(6).toString('hex')}`,
                android_version: '14',
                app_build_version: '2.0.0',
                site_code_embedded: 'SITE',
            })

        response.assertStatus(422)
        response.assertBodyContains({ message: 'Dokumen consent tidak ditemukan untuk site ini' })
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
