import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { laravelUrlSigner } from '#services/laravel/index'
import {
    bearerFor,
    makeConsentDocument,
    makeDevice,
    makeOrganization,
    makeUser,
} from './rules_helpers.js'

/**
 * Padanan tests/Feature/GeofenceRuleAuthorizationTest.php: 'exists:devices,id'
 * saja cuma mengecek device-nya ADA, bukan device-nya milik site yang sama
 * dengan aturan geofence -- admin site A bisa tanam anchor_device_id milik
 * site B, dan nama device B bocor lewat GeofenceRuleResource.
 */
test.group('Aturan geofence: anchor device lintas site', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('site_admin TIDAK BISA pakai device org lain sebagai anchor saat membuat aturan', async ({
        client,
        assert,
    }) => {
        const orgA = await makeOrganization()
        const orgB = await makeOrganization()
        const admin = await makeUser(orgA, 'site_admin')
        const deviceOfOrgB = await makeDevice(orgB, admin)

        const response = await client
            .post('/api/v1/geofence-rules')
            .bearerToken(await bearerFor(admin))
            .json({
                organization_id: orgA,
                rule_name: 'Kantor Utama',
                anchor_device_id: deviceOfOrgB,
            })

        response.assertStatus(422)
        response.assertBodyContains({
            success: false,
            message: 'Device anchor harus milik site yang sama',
        })
        const rule = await db.from('geofence_rules').where('rule_name', 'Kantor Utama').first()
        assert.isNull(rule ?? null)
    })

    test('site_admin TIDAK BISA ganti anchor ke device org lain saat update', async ({
        client,
        assert,
    }) => {
        const orgA = await makeOrganization()
        const orgB = await makeOrganization()
        const admin = await makeUser(orgA, 'site_admin')
        const deviceOfOrgB = await makeDevice(orgB, admin)
        const [rule] = await db
            .table('geofence_rules')
            .insert({
                organization_id: orgA,
                rule_name: 'Aturan A',
                is_active: true,
                created_by: admin,
                created_at: new Date(),
                updated_at: new Date(),
            })
            .returning(['id'])

        const response = await client
            .put(`/api/v1/geofence-rules/${rule.id}`)
            .bearerToken(await bearerFor(admin))
            .json({ anchor_device_id: deviceOfOrgB })

        response.assertStatus(422)
        const fresh = await db.from('geofence_rules').where('id', rule.id).first()
        assert.isNull(fresh.anchor_device_id)
    })

    test('site_admin BISA pakai device org sendiri sebagai anchor', async ({ client, assert }) => {
        const org = await makeOrganization()
        const admin = await makeUser(org, 'site_admin')
        const device = await makeDevice(org, admin)

        const response = await client
            .post('/api/v1/geofence-rules')
            .bearerToken(await bearerFor(admin))
            .json({ organization_id: org, rule_name: 'Kantor Utama', anchor_device_id: device })

        response.assertStatus(201)
        response.assertBodyContains({
            success: true,
            message: 'Aturan geofence berhasil dibuat',
            data: {
                organization_id: org,
                rule_name: 'Kantor Utama',
                anchor_device_id: device,
                is_active: true,
            },
        })

        // LogsActivity GeofenceRule: event created dengan atribut logOnly.
        const log = await db
            .from('activity_log')
            .where('subject_type', String.raw`App\Models\GeofenceRule`)
            .where('subject_id', response.body().data.id)
            .where('event', 'created')
            .first()
        assert.exists(log)
    })

    test('site_admin tidak bisa membuat aturan untuk site lain', async ({ client }) => {
        const orgA = await makeOrganization()
        const orgB = await makeOrganization()
        const admin = await makeUser(orgA, 'site_admin')

        const response = await client
            .post('/api/v1/geofence-rules')
            .bearerToken(await bearerFor(admin))
            .json({ organization_id: orgB, rule_name: 'Bukan Milikku' })

        response.assertStatus(403)
        response.assertBodyContains({
            message: 'Anda tidak berwenang membuat aturan untuk site ini',
        })
    })

    test('staff_viewer tanpa geofence-rules.manage ditolak', async ({ client }) => {
        const org = await makeOrganization()
        const viewer = await makeUser(org, 'staff_viewer')

        const response = await client
            .get('/api/v1/geofence-rules')
            .bearerToken(await bearerFor(viewer))

        response.assertStatus(403)
        response.assertBodyContains({ message: 'Anda tidak berwenang melakukan tindakan ini' })
    })
})

test.group('Dokumen consent: scoping & unduhan bertanda tangan', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('site_admin tidak bisa melihat dokumen site lain', async ({ client }) => {
        const orgA = await makeOrganization()
        const orgB = await makeOrganization()
        const admin = await makeUser(orgA, 'site_admin')
        const documentOfOrgB = await makeConsentDocument(orgB, admin)

        const response = await client
            .get(`/api/v1/consent-documents/${documentOfOrgB}`)
            .bearerToken(await bearerFor(admin))

        response.assertStatus(403)
        response.assertBodyContains({ message: 'Anda tidak berwenang melihat dokumen ini' })
    })

    test('unduhan tanpa tanda tangan ditolak, bertanda tangan tapi berkas hilang 404', async ({
        client,
    }) => {
        const org = await makeOrganization()
        const admin = await makeUser(org, 'site_admin')
        const documentId = await makeConsentDocument(org, admin)
        const path = `/api/v1/consent-documents/${documentId}/download`

        const unsigned = await client.get(path)
        unsigned.assertStatus(403)

        const signedUrl = new URL(
            laravelUrlSigner.temporarySignedUrl(path, new Date(Date.now() + 60_000))
        )
        const signed = await client.get(`${path}${signedUrl.search}`)
        signed.assertStatus(404)
        signed.assertBodyContains({ message: 'Berkas tidak ditemukan' })
    })
})
