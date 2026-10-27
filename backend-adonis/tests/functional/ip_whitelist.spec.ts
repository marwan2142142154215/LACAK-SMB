import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { hashLaravelPassword } from '#services/laravel/bcrypt'
import { forgetIpWhitelistCache, normalizeEntry } from '#services/ip_whitelist'
import { setTwoFactorRequired } from '#services/two_factor_policy'
import { clearAppRedisKeys } from '#tests/helpers/setup'
import { assignRole, bearerFor, makeOrganization, makeUser } from './rules_helpers.js'

const OFFICE = '103.10.20.30'
const HOME = '182.1.2.3'
const PASSWORD = 'password-benar'

/** Super admin dengan izin security.manage (pengelola whitelist). */
async function superAdmin() {
    const id = await makeUser(null, 'super_admin')
    const [permission] = await db
        .table('permissions')
        .insert({
            name: 'security.manage',
            guard_name: 'web',
            created_at: new Date(),
            updated_at: new Date(),
        })
        .onConflict(['name', 'guard_name'])
        .merge()
        .returning(['id'])
    const role = await db
        .from('roles')
        .where({ name: 'super_admin', guard_name: 'web' })
        .firstOrFail()
    await db
        .table('role_has_permissions')
        .insert({ role_id: role.id, permission_id: permission.id })
        .onConflict(['permission_id', 'role_id'])
        .ignore()
    return { id, bearer: await bearerFor(id) }
}

test.group('Whitelist IP', (group) => {
    group.each.setup(async () => {
        await clearAppRedisKeys()
        forgetIpWhitelistCache()
        return testUtils.db().withGlobalTransaction()
    })
    // Cache whitelist di memori tidak ikut rollback -- jangan bocor ke tes lain.
    group.each.teardown(() => forgetIpWhitelistCache())

    test('entri IP & CIDR dinormalkan, yang tidak sah ditolak', ({ assert }) => {
        assert.equal(normalizeEntry(' 103.10.20.30 '), '103.10.20.30')
        assert.equal(normalizeEntry('192.168.1.0/24'), '192.168.1.0/24')
        assert.equal(normalizeEntry('::ffff:10.0.0.5'), '10.0.0.5')
        assert.equal(normalizeEntry('2001:db8::/32'), '2001:db8::/32')
        assert.isNull(normalizeEntry('10.0.0.0/33'))
        assert.isNull(normalizeEntry('kantor'))
        assert.isNull(normalizeEntry('1.2.3.4/8/1'))
    })

    test('aktif: staf di luar daftar ditolak di setiap request & saat login, root tetap bisa', async ({
        client,
        assert,
    }) => {
        await setTwoFactorRequired(false, null)
        const root = await superAdmin()
        const site = await makeOrganization()
        const staffId = await makeUser(site, 'staff_viewer')
        await db
            .from('users')
            .where('id', staffId)
            .update({ password: await hashLaravelPassword(PASSWORD, 4) })
        const staff = await bearerFor(staffId)
        const { username } = await db.from('users').where('id', staffId).firstOrFail()

        // Tidak bisa diaktifkan tanpa IP, dan entri harus sah.
        const empty = await client
            .put('/api/v1/settings/ip-whitelist')
            .header('Authorization', `Bearer ${root.bearer}`)
            .json({ enabled: true, entries: [] })
        empty.assertStatus(422)
        const invalid = await client
            .put('/api/v1/settings/ip-whitelist')
            .header('Authorization', `Bearer ${root.bearer}`)
            .json({ enabled: true, entries: [{ value: 'bukan-ip', label: '' }] })
        invalid.assertStatus(422)
        assert.isArray(invalid.body().errors['entries.0.value'])

        // Staf biasa tidak boleh mengatur whitelist.
        const notAllowed = await client
            .get('/api/v1/settings/ip-whitelist')
            .header('Authorization', `Bearer ${staff}`)
        notAllowed.assertStatus(403)

        const saved = await client
            .put('/api/v1/settings/ip-whitelist')
            .header('Authorization', `Bearer ${root.bearer}`)
            .header('X-Forwarded-For', HOME)
            .json({
                enabled: true,
                entries: [
                    { value: '103.10.20.0/24', label: 'Kantor pusat' },
                    { value: '103.10.20.0/24', label: 'duplikat' },
                ],
            })
        saved.assertStatus(200)
        assert.deepEqual(saved.body().data.entries, [
            { value: '103.10.20.0/24', label: 'Kantor pusat' },
        ])
        // Root dikecualikan: masih bisa mengakses walau dari IP rumah.
        assert.equal(saved.body().data.current_ip, HOME)

        const fromOffice = await client
            .get('/api/v1/auth/me')
            .header('Authorization', `Bearer ${staff}`)
            .header('X-Forwarded-For', OFFICE)
        fromOffice.assertStatus(200)

        const fromHome = await client
            .get('/api/v1/auth/me')
            .header('Authorization', `Bearer ${staff}`)
            .header('X-Forwarded-For', HOME)
        fromHome.assertStatus(403)
        assert.equal(fromHome.body().errors.reason, 'ip_not_allowed')
        assert.equal(fromHome.body().errors.ip, HOME)

        const loginHome = await client
            .post('/api/v1/auth/login')
            .header('X-Forwarded-For', HOME)
            .json({ username, password: PASSWORD })
        loginHome.assertStatus(403)
        assert.equal(loginHome.body().errors.reason, 'ip_not_allowed')

        // Password salah tetap 401 -- penolakan IP tidak membocorkan akun.
        const wrong = await client
            .post('/api/v1/auth/login')
            .header('X-Forwarded-For', HOME)
            .json({ username, password: 'salah' })
        wrong.assertStatus(401)

        const loginOffice = await client
            .post('/api/v1/auth/login')
            .header('X-Forwarded-For', OFFICE)
            .json({ username, password: PASSWORD })
        loginOffice.assertStatus(200)
        assert.isString(loginOffice.body().data.access_token)

        // Dimatikan: bebas dari mana saja lagi. (Login barusan mencabut token
        // lama staf -- satu akun satu sesi -- jadi pakai token barunya.)
        const off = await client
            .put('/api/v1/settings/ip-whitelist')
            .header('Authorization', `Bearer ${root.bearer}`)
            .json({ enabled: false, entries: saved.body().data.entries })
        off.assertStatus(200)
        const afterOff = await client
            .get('/api/v1/auth/me')
            .header('Authorization', `Bearer ${loginOffice.body().data.access_token}`)
            .header('X-Forwarded-For', HOME)
        afterOff.assertStatus(200)
    })

    test('akun layanan bot Telegram dikecualikan', async ({ client }) => {
        const root = await superAdmin()
        const botId = await makeUser(null, 'telegram_bot_service')
        await assignRole(botId, 'staff_viewer')
        const bot = await bearerFor(botId)

        await client
            .put('/api/v1/settings/ip-whitelist')
            .header('Authorization', `Bearer ${root.bearer}`)
            .json({ enabled: true, entries: [{ value: OFFICE, label: 'Kantor' }] })
            .then((response) => response.assertStatus(200))

        const response = await client
            .get('/api/v1/auth/me')
            .header('Authorization', `Bearer ${bot}`)
            .header('X-Forwarded-For', HOME)
        response.assertStatus(200)
    })

    test('cek IP publik: hanya memberi tahu boleh/tidaknya IP pemanggil', async ({
        client,
        assert,
    }) => {
        const root = await superAdmin()

        const before = await client.get('/api/v1/auth/ip-check').header('X-Forwarded-For', HOME)
        before.assertStatus(200)
        assert.deepEqual(before.body().data, { ip: HOME, allowed: true })

        await client
            .put('/api/v1/settings/ip-whitelist')
            .header('Authorization', `Bearer ${root.bearer}`)
            .json({ enabled: true, entries: [{ value: '103.10.20.0/24', label: 'Kantor' }] })
            .then((response) => response.assertStatus(200))

        const home = await client.get('/api/v1/auth/ip-check').header('X-Forwarded-For', HOME)
        assert.deepEqual(home.body().data, { ip: HOME, allowed: false })
        assert.notInclude(JSON.stringify(home.body()), '103.10.20.0')

        const office = await client.get('/api/v1/auth/ip-check').header('X-Forwarded-For', OFFICE)
        assert.deepEqual(office.body().data, { ip: OFFICE, allowed: true })
    })
})
