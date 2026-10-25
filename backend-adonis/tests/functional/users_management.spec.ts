import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import PersonalAccessToken from '#models/personal_access_token'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'

/*
| Padanan tes fitur backend-api untuk staf, site & pengaturan keamanan
| (AuthenticationTest "membuat staf ...", TwoFactorToggleTest). Butuh database
| tes lacak_master_test hasil migrasi Laravel.
*/

/** Izin per peran -- potongan RolesAndPermissionsSeeder yang dipakai di sini. */
const ROLE_PERMISSIONS: Record<string, string[]> = {
    super_admin: ['users.manage', 'organizations.manage', 'security.manage'],
    admin: [],
    leader: [],
    site_admin: [],
    staff_viewer: [],
}

async function ensureRole(name: string) {
    const now = new Date()
    await db
        .table('roles')
        .insert({ name, guard_name: 'web', created_at: now, updated_at: now })
        .onConflict(['name', 'guard_name'])
        .ignore()
    const role = await db.from('roles').where({ name, guard_name: 'web' }).firstOrFail()

    for (const permission of ROLE_PERMISSIONS[name] ?? []) {
        await db
            .table('permissions')
            .insert({ name: permission, guard_name: 'web', created_at: now, updated_at: now })
            .onConflict(['name', 'guard_name'])
            .ignore()
        const row = await db
            .from('permissions')
            .where({ name: permission, guard_name: 'web' })
            .firstOrFail()
        await db
            .table('role_has_permissions')
            .insert({ permission_id: row.id, role_id: role.id })
            .onConflict(['permission_id', 'role_id'])
            .ignore()
    }
    return role.id as number
}

async function userWithRole(role: string | null, attributes: Record<string, unknown> = {}) {
    for (const name of Object.keys(ROLE_PERMISSIONS)) await ensureRole(name)

    const suffix = randomBytes(4).toString('hex')
    const [user] = await db
        .table('users')
        .insert({
            username: `uji.${suffix}`,
            name: `Uji ${suffix}`,
            email: `uji.${suffix}@example.test`,
            password: '$2y$10$Y18XUtkwVNaSkDxG0mGKX.51ec8i1y3rdvE4Cc.QSg9izFzIo/CiO',
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
            ...attributes,
        })
        .returning(['id'])

    if (role) {
        const roleRow = await db.from('roles').where({ name: role, guard_name: 'web' }).first()
        await db.table('model_has_roles').insert({
            role_id: roleRow.id,
            model_type: LARAVEL_USER_MORPH,
            model_id: user.id,
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

async function organization(name = 'Site Uji') {
    const [row] = await db
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
    return row.id as number
}

test.group('Staf: kelola staf (users.manage)', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('username huruf besar disimpan huruf kecil dan tidak bisa menduplikasi', async ({
        client,
        assert,
    }) => {
        const root = await userWithRole('super_admin')
        await userWithRole(null, { username: 'budi' })
        const payload = {
            name: 'Budi Dua',
            email: 'budi2@example.com',
            password: 'rahasia-panjang',
            role: 'admin',
        }

        const duplicate = await client
            .post('/api/v1/users')
            .bearerToken(root.bearer)
            .json({ ...payload, username: 'Budi' })
        duplicate.assertStatus(422)
        duplicate.assertBodyContains({
            success: false,
            message: 'Isian tidak lolos validasi',
            errors: { username: ['The username has already been taken.'] },
        })

        const created = await client
            .post('/api/v1/users')
            .bearerToken(root.bearer)
            .json({ ...payload, username: 'Budi.Dua' })
        created.assertStatus(201)
        created.assertBodyContains({
            success: true,
            message: 'Staf berhasil dibuat',
            data: { username: 'budi.dua', role: 'admin', is_active: true, site_access: [] },
        })

        assert.isNotNull(await db.from('users').where('username', 'budi.dua').first())
        const log = await db
            .from('activity_log')
            .where('subject_type', LARAVEL_USER_MORPH)
            .where('subject_id', created.body().data.id)
            .where('event', 'created')
            .first()
        assert.isNotNull(log)
    })

    test('selain pemegang users.manage ditolak 403', async ({ client }) => {
        const viewer = await userWithRole('staff_viewer')
        const target = await userWithRole('staff_viewer')

        for (const request of [
            client.get('/api/v1/users'),
            client.post('/api/v1/users').json({}),
            client.get(`/api/v1/users/${target.id}`),
            client.put(`/api/v1/users/${target.id}`).json({ name: 'X' }),
            client.post(`/api/v1/users/${target.id}/suspend`),
        ]) {
            const response = await request.bearerToken(viewer.bearer)
            response.assertStatus(403)
            response.assertBody({
                success: false,
                message: 'Anda tidak berwenang melakukan tindakan ini',
                errors: null,
            })
        }
    })

    test('staf yang tidak ada dibalas 404', async ({ client }) => {
        const root = await userWithRole('super_admin')
        const response = await client.get('/api/v1/users/999999999').bearerToken(root.bearer)
        response.assertStatus(404)
    })

    test('suspend mencabut semua token, tidak bisa suspend/hapus diri sendiri', async ({
        client,
        assert,
    }) => {
        const root = await userWithRole('super_admin')
        const target = await userWithRole('staff_viewer')

        const self = await client.post(`/api/v1/users/${root.id}/suspend`).bearerToken(root.bearer)
        self.assertStatus(422)
        self.assertBody({
            success: false,
            message: 'Tidak bisa men-suspend akun sendiri',
            errors: null,
        })

        const selfDelete = await client.delete(`/api/v1/users/${root.id}`).bearerToken(root.bearer)
        selfDelete.assertStatus(422)

        const response = await client
            .post(`/api/v1/users/${target.id}/suspend`)
            .bearerToken(root.bearer)
        response.assertStatus(200)
        response.assertBodyContains({
            message: 'Staf disuspen — semua sesi login dicabut',
            data: { id: target.id, is_active: false },
        })

        const tokens = await db
            .from('personal_access_tokens')
            .where('tokenable_type', LARAVEL_USER_MORPH)
            .where('tokenable_id', target.id)
        assert.lengthOf(tokens, 0)

        const reactivated = await client
            .post(`/api/v1/users/${target.id}/reactivate`)
            .bearerToken(root.bearer)
        reactivated.assertBodyContains({ data: { is_active: true } })
    })

    test('reset 2FA mengosongkan secret dan mencabut sesi', async ({ client, assert }) => {
        const root = await userWithRole('super_admin')
        const target = await userWithRole('staff_viewer', {
            two_factor_secret: 'rahasia-terenkripsi',
            two_factor_confirmed_at: new Date(),
        })

        const response = await client
            .post(`/api/v1/users/${target.id}/reset-2fa`)
            .bearerToken(root.bearer)
        response.assertStatus(200)

        const row = await db.from('users').where('id', target.id).first()
        assert.isNull(row.two_factor_secret)
        assert.isNull(row.two_factor_confirmed_at)
    })

    test('update: email unik kecuali milik sendiri, peran diganti', async ({ client }) => {
        const root = await userWithRole('super_admin')
        const target = await userWithRole('staff_viewer')
        const other = await userWithRole('staff_viewer')
        const otherRow = await db.from('users').where('id', other.id).first()
        const otherEmail = otherRow.email

        const taken = await client
            .put(`/api/v1/users/${target.id}`)
            .bearerToken(root.bearer)
            .json({ email: otherEmail })
        taken.assertStatus(422)
        taken.assertBodyContains({ errors: { email: ['The email has already been taken.'] } })

        const ok = await client
            .put(`/api/v1/users/${target.id}`)
            .bearerToken(root.bearer)
            .json({ name: 'Nama Baru', role: 'leader' })
        ok.assertStatus(200)
        ok.assertBodyContains({
            message: 'Staf berhasil diperbarui',
            data: { name: 'Nama Baru', role: 'leader' },
        })
    })

    test('akses site disinkronkan, daftar kosong ditolak', async ({ client }) => {
        const root = await userWithRole('super_admin')
        const target = await userWithRole('admin')
        const siteA = await organization('Site A')
        const siteB = await organization('Site B')

        const empty = await client
            .put(`/api/v1/users/${target.id}/site-access`)
            .bearerToken(root.bearer)
            .json({ organization_ids: [] })
        empty.assertStatus(422)
        empty.assertBodyContains({
            errors: { organization_ids: ['The organization ids field is required.'] },
        })

        const response = await client
            .put(`/api/v1/users/${target.id}/site-access`)
            .bearerToken(root.bearer)
            .json({ organization_ids: [siteA, siteB] })
        response.assertStatus(200)
        response.assertBodyContains({
            message: 'Akses site diperbarui',
            data: {
                site_access: [
                    { id: siteA, name: 'Site A' },
                    { id: siteB, name: 'Site B' },
                ],
            },
        })
    })
})

test.group('Site: kelola site (organizations.manage)', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('membuat site dengan kode berawalan slug nama', async ({ client }) => {
        const root = await userWithRole('super_admin')

        const response = await client
            .post('/api/v1/organizations')
            .bearerToken(root.bearer)
            .json({ name: 'Dev Test', type: 'company_asset' })
        response.assertStatus(201)
        response.assertBodyContains({
            success: true,
            message: 'Site berhasil dibuat',
            data: { name: 'Dev Test', type: 'company_asset', is_active: true },
        })
        const code: string = response.body().data.unique_site_code
        if (!/^DEVTEST-[A-Z0-9]{8}$/.test(code)) {
            throw new Error(`Kode site tidak sesuai: ${code}`)
        }
    })

    test('daftar site membawa devices_count, total, last_page', async ({ client, assert }) => {
        const root = await userWithRole('super_admin')
        await organization('Site Daftar')

        const response = await client
            .get('/api/v1/organizations')
            .qs({ per_page: 1 })
            .bearerToken(root.bearer)
        response.assertStatus(200)
        const data = response.body().data
        assert.properties(data, ['items', 'total', 'last_page'])
        assert.property(data.items[0], 'devices_count')
    })

    test('hapus site = soft delete, lalu 404', async ({ client }) => {
        const root = await userWithRole('super_admin')
        const site = await organization('Site Hapus')

        const deleted = await client
            .delete(`/api/v1/organizations/${site}`)
            .bearerToken(root.bearer)
        deleted.assertBody({
            success: true,
            message: 'Site berhasil dihapus (soft delete)',
            data: null,
        })

        const gone = await client.get(`/api/v1/organizations/${site}`).bearerToken(root.bearer)
        gone.assertStatus(404)
    })
})

test.group('Pengaturan keamanan (security.manage)', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('hanya super_admin yang boleh melihat dan mengubah pengaturan 2FA', async ({ client }) => {
        for (const role of ['admin', 'leader', 'site_admin', 'staff_viewer']) {
            const user = await userWithRole(role)
            const shown = await client.get('/api/v1/settings/security').bearerToken(user.bearer)
            shown.assertStatus(403)
            const changed = await client
                .put('/api/v1/settings/security')
                .bearerToken(user.bearer)
                .json({ two_factor_required: false })
            changed.assertStatus(403)
        }
    })

    test('super_admin bisa mematikan dan menyalakan 2FA, dan perubahannya tercatat', async ({
        client,
        assert,
    }) => {
        const root = await userWithRole('super_admin')

        const shown = await client.get('/api/v1/settings/security').bearerToken(root.bearer)
        shown.assertBodyContains({ data: { two_factor_required: true } })

        const off = await client
            .put('/api/v1/settings/security')
            .bearerToken(root.bearer)
            .json({ two_factor_required: false })
        off.assertStatus(200)
        off.assertBody({
            success: true,
            message: '2FA dimatikan: login cukup dengan password',
            data: { two_factor_required: false },
        })

        const setting = await db
            .from('app_settings')
            .where('key', 'auth.two_factor_required')
            .first()
        assert.equal(setting.updated_by, root.id)

        const on = await client
            .put('/api/v1/settings/security')
            .bearerToken(root.bearer)
            .json({ two_factor_required: true })
        on.assertBodyContains({
            message: '2FA kembali wajib saat login',
            data: { two_factor_required: true },
        })
    })

    test('two_factor_required wajib boolean', async ({ client }) => {
        const root = await userWithRole('super_admin')
        const response = await client
            .put('/api/v1/settings/security')
            .bearerToken(root.bearer)
            .json({ two_factor_required: 'mungkin' })
        response.assertStatus(422)
        response.assertBodyContains({
            errors: {
                two_factor_required: ['The two factor required field must be true or false.'],
            },
        })
    })
})
