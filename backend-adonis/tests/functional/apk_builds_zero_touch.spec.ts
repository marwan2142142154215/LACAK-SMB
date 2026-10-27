import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'
import { appQueue, JOB_BUILD_APK } from '#services/queue'
import { decodeDeviceSecret, type BuildApkPayload } from '#jobs/build_apk_job'

/**
 * Padanan tests/Feature/ApkBuildZeroTouchTest.php. Butuh database tes
 * (skema dari migrasi Laravel) dan Redis antrean. Job build yang terkirim
 * diperiksa langsung di antrean lalu dibuang -- worker tidak dijalankan,
 * jadi Gradle/WSL tidak tersentuh (pengganti Queue::fake()).
 */

const suffix = () => randomBytes(4).toString('hex')

async function organization() {
    const [row] = await db
        .table('organizations')
        .insert({
            name: `Site Uji ${suffix()}`,
            unique_site_code: `UJI-${suffix()}`.toUpperCase(),
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])
    return row.id as number
}

/** Baris roles/permissions guard 'web' (RolesAndPermissionsSeeder), dibuat kalau belum ada. */
async function spatieRow(table: 'roles' | 'permissions', name: string): Promise<{ id: number }> {
    const existing = await db.from(table).where('name', name).where('guard_name', 'web').first()
    if (existing) return existing
    const [created] = await db
        .table(table)
        .insert({ name, guard_name: 'web', created_at: new Date(), updated_at: new Date() })
        .returning(['id'])
    return created
}

async function siteAdmin(organizationId: number) {
    const [user] = await db
        .table('users')
        .insert({
            username: `uji.apk.${suffix()}`,
            name: 'Uji APK',
            email: `uji.apk.${suffix()}@example.test`,
            password: '$2y$10$Y18XUtkwVNaSkDxG0mGKX.51ec8i1y3rdvE4Cc.QSg9izFzIo/CiO',
            organization_id: organizationId,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])

    const role = await spatieRow('roles', 'site_admin')
    const permission = await spatieRow('permissions', 'apk-builds.manage')

    const linked = await db
        .from('role_has_permissions')
        .where({ role_id: role.id, permission_id: permission.id })
        .first()
    if (!linked) {
        await db.table('role_has_permissions').insert({
            role_id: role.id,
            permission_id: permission.id,
        })
    }
    await db.table('model_has_roles').insert({
        role_id: role.id,
        model_type: LARAVEL_USER_MORPH,
        model_id: user.id,
    })

    const plain = randomBytes(20).toString('hex')
    const [token] = await db
        .table('personal_access_tokens')
        .insert({
            tokenable_type: LARAVEL_USER_MORPH,
            tokenable_id: user.id,
            name: `uji-${Date.now()}`,
            token: createHash('sha256').update(plain).digest('hex'),
            abilities: '["*"]',
            expires_at: new Date(Date.now() + 2 * 3600_000),
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])

    return { userId: user.id as number, bearer: `${token.id}|${plain}` }
}

/** Job build untuk apk_build ini (lalu dibuang dari antrean). */
async function takeBuildJob(apkBuildId: number) {
    const jobs = await appQueue().getJobs(['waiting', 'delayed', 'prioritized'])
    const job = jobs.find(
        (candidate) =>
            candidate.name === JOB_BUILD_APK &&
            (candidate.data as BuildApkPayload).apkBuildId === apkBuildId
    )
    await job?.remove()
    return job ? (job.data as BuildApkPayload) : null
}

test.group('APK build: zero-touch (ApkBuildZeroTouchTest)', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('build APK tracker otomatis membuat device dengan rahasia device', async ({
        client,
        assert,
    }) => {
        const org = await organization()
        const { bearer } = await siteAdmin(org)

        const response = await client.post('/api/v1/apk-builds/generate').bearerToken(bearer).json({
            organization_id: org,
            apk_type: 'tracker',
            version: '1.0.0',
            device_name: 'HP Test Zero-Touch',
        })

        response.assertStatus(202)
        response.assertBodyContains({
            success: true,
            data: { apk_type: 'tracker', status: 'pending', download_url: null },
        })

        const device = await db.from('devices').where('device_name', 'HP Test Zero-Touch').first()
        assert.isNotNull(device)
        assert.isNotEmpty(device.device_uuid)
        assert.match(device.secret_hash, /^[0-9a-f]{64}$/)
        assert.isNull(device.consent_document_id)
        assert.equal(device.status, 'pending_enrollment')

        const buildId = response.body().data.id
        const build = await db.from('apk_builds').where('id', buildId).first()
        assert.equal(build.device_id, device.id)

        const payload = await takeBuildJob(buildId)
        assert.isNotNull(payload)
        const secret = decodeDeviceSecret(payload!)
        assert.isNotNull(secret)
        assert.equal(createHash('sha256').update(secret!).digest('hex'), device.secret_hash)
    })

    test('build APK master TIDAK membuat device sama sekali', async ({ client, assert }) => {
        const org = await organization()
        const { bearer } = await siteAdmin(org)
        const before = await db.from('devices').count('* as total').first()

        const response = await client
            .post('/api/v1/apk-builds/generate')
            .bearerToken(bearer)
            .json({ organization_id: org, apk_type: 'master', version: '1.0.0' })

        response.assertStatus(202)
        const after = await db.from('devices').count('* as total').first()
        assert.equal(Number(after.total), Number(before.total))

        const payload = await takeBuildJob(response.body().data.id)
        assert.isNotNull(payload)
        assert.isNull(payload!.deviceSecret)
    })

    test('build APK live diterima tanpa device', async ({ client, assert }) => {
        const org = await organization()
        const { bearer } = await siteAdmin(org)

        const response = await client
            .post('/api/v1/apk-builds/generate')
            .bearerToken(bearer)
            .json({ organization_id: org, apk_type: 'live', version: '1.0.0' })

        response.assertStatus(202)
        assert.equal(response.body().data.apk_type, 'live')
        const payload = await takeBuildJob(response.body().data.id)
        assert.isNull(payload!.deviceSecret)
    })

    test('validasi memakai pesan bawaan Laravel', async ({ client }) => {
        const org = await organization()
        const { bearer } = await siteAdmin(org)

        const response = await client
            .post('/api/v1/apk-builds/generate')
            .bearerToken(bearer)
            .json({ organization_id: org, apk_type: 'tracker', version: '1.0' })

        response.assertStatus(422)
        response.assertBody({
            success: false,
            message: 'Isian tidak lolos validasi',
            errors: {
                version: ['The version field format is invalid.'],
                device_name: ['The device name field is required when apk type is tracker.'],
            },
        })
    })

    test('tanpa izin apk-builds.manage ditolak 403', async ({ client }) => {
        const org = await organization()
        const { userId, bearer } = await siteAdmin(org)
        await db.from('model_has_roles').where('model_id', userId).delete()

        const response = await client
            .post('/api/v1/apk-builds/generate')
            .bearerToken(bearer)
            .json({ organization_id: org, apk_type: 'master' })

        response.assertStatus(403)
        response.assertBodyContains({ message: 'Anda tidak berwenang melakukan tindakan ini' })
    })

    test('unduhan tanpa tanda tangan ditolak, build tak dikenal 404', async ({ client }) => {
        const org = await organization()
        const { userId } = await siteAdmin(org)
        const [build] = await db
            .table('apk_builds')
            .insert({
                organization_id: org,
                apk_type: 'master',
                version: '1.0.0',
                status: 'success',
                file_path: 'apk-builds/x/master-1.apk',
                embedded_site_code: 'MASTER-UNIVERSAL',
                checksum_sha256: 'abc',
                built_by: userId,
                created_at: new Date(),
                updated_at: new Date(),
            })
            .returning(['id'])

        const unsigned = await client.get(`/api/v1/apk-builds/${build.id}/download`)
        unsigned.assertStatus(403)

        const missing = await client.get('/api/v1/apk-builds/999999999/download')
        missing.assertStatus(404)
    })
})
