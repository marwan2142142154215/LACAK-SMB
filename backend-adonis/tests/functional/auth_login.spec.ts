import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import testUtils from '@adonisjs/core/services/test_utils'
import { generateTokenString } from '#controllers/auth_controller'
import { hashLaravelPassword } from '#services/laravel/bcrypt'
import { laravelEncrypter, LARAVEL_USER_MORPH } from '#services/laravel/index'
import { currentTimestamp, generateSecretKey, otpAt } from '#services/two_factor'
import {
    isTwoFactorRequired,
    setTwoFactorRequired,
    TWO_FACTOR_SETTING_KEY,
} from '#services/two_factor_policy'

/**
 * Padanan backend-api/tests/Feature/AuthenticationTest.php,
 * TwoFactorToggleTest.php (bagian login), dan AccountCenterLoginTest.php
 * (bagian password lokal). Database: lacak_master_test (transaksi global
 * di-rollback); Redis: key throttle & auth milik Adonis dibersihkan tiap tes.
 */

const PASSWORD = 'password-benar'
let passwordHash: string

async function clearRedisKeys() {
    const prefix = 'lacak-adonis:'
    for (const pattern of ['throttle:*', 'auth:*']) {
        const keys = await redis.keys(pattern)
        if (keys.length) {
            await redis.del(...keys.map((key) => key.replace(prefix, '')))
        }
    }
}

async function createUser(overrides: Record<string, unknown> = {}) {
    const suffix = randomBytes(4).toString('hex')
    const [row] = await db
        .table('users')
        .insert({
            username: `uji.login.${suffix}`,
            name: 'Uji Login',
            email: `uji.login.${suffix}@example.test`,
            password: passwordHash,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
            ...overrides,
        })
        .returning(['id', 'username'])
    return { id: row.id as number, username: row.username as string }
}

/** Beri izin langsung ke user (tabel spatie model_has_permissions). */
async function givePermission(userId: number, name: string) {
    let permission = await db.from('permissions').where('name', name).first()
    if (!permission) {
        ;[permission] = await db
            .table('permissions')
            .insert({ name, guard_name: 'web', created_at: new Date(), updated_at: new Date() })
            .returning(['id'])
    }
    await db.table('model_has_permissions').insert({
        permission_id: permission.id,
        model_type: LARAVEL_USER_MORPH,
        model_id: userId,
    })
}

async function tokensOf(userId: number) {
    return db
        .from('personal_access_tokens')
        .where('tokenable_type', LARAVEL_USER_MORPH)
        .where('tokenable_id', userId)
        .orderBy('id')
}

test.group('Auth: login, 2FA, logout', (group) => {
    group.setup(async () => {
        passwordHash = await hashLaravelPassword(PASSWORD, 4)
    })
    group.each.setup(() => testUtils.db().withGlobalTransaction())
    group.each.setup(async () => {
        await clearRedisKeys()
    })

    test('login salah password ditolak 401', async ({ client }) => {
        const user = await createUser()

        const response = await client
            .post('/api/v1/auth/login')
            .json({ username: user.username, password: 'password-salah' })

        response.assertStatus(401)
        response.assertBody({
            success: false,
            message: 'Username atau password salah',
            errors: null,
        })
    })

    test('validasi gagal -> 422 dengan pesan Laravel', async ({ client }) => {
        const response = await client.post('/api/v1/auth/login').json({ username: '  ' })

        response.assertStatus(422)
        response.assertBody({
            success: false,
            message: 'Isian tidak lolos validasi',
            errors: {
                username: ['The username field is required.'],
                password: ['The password field is required.'],
            },
        })
    })

    test('username tidak peka huruf besar saat login', async ({ client }) => {
        await setTwoFactorRequired(false, null)
        const user = await createUser({ username: 'staf.a1' })

        for (const typed of ['Staf.a1', 'STAF.A1', ' staf.a1 ']) {
            await clearRedisKeys()
            const response = await client
                .post('/api/v1/auth/login')
                .json({ username: typed, password: PASSWORD })
            response.assertStatus(200)
            response.assertBodyContains({ success: true, data: { user: { id: user.id } } })
        }
    })

    test('akun nonaktif ditolak 403', async ({ client }) => {
        const user = await createUser({ is_active: false })

        const response = await client
            .post('/api/v1/auth/login')
            .json({ username: user.username, password: PASSWORD })

        response.assertStatus(403)
        response.assertBodyContains({ message: 'Akun Anda dinonaktifkan. Hubungi super admin.' })
    })

    test('login pertama (belum confirm 2FA) balas QR setup, bukan token', async ({
        client,
        assert,
    }) => {
        assert.isTrue(await isTwoFactorRequired())
        const user = await createUser()

        const response = await client
            .post('/api/v1/auth/login')
            .json({ username: user.username, password: PASSWORD })

        response.assertStatus(200)
        const data = response.body().data
        assert.isTrue(data.requires_2fa_setup)
        assert.match(data.setup_token, /^[A-Za-z0-9]{48}$/)
        assert.match(data.secret_manual_entry, /^[A-Z2-7]{16}$/)
        assert.include(data.qr_code_svg, '<svg')
        assert.equal(data.expires_in_seconds, 600)
        assert.notProperty(data, 'access_token')
    })

    test('konfirmasi setup 2FA mengeluarkan token idle 2 jam + recovery code', async ({
        client,
        assert,
    }) => {
        const user = await createUser()
        const login = await client
            .post('/api/v1/auth/login')
            .json({ username: user.username, password: PASSWORD })
        const { setup_token: setupToken, secret_manual_entry: secret } = login.body().data

        const wrong = await client
            .post('/api/v1/auth/2fa/setup/confirm')
            .json({ setup_token: setupToken, code: '000000' })
        wrong.assertStatus(422)

        const confirm = await client
            .post('/api/v1/auth/2fa/setup/confirm')
            .json({ setup_token: setupToken, code: otpAt(secret, currentTimestamp()) })

        confirm.assertStatus(200)
        const data = confirm.body().data
        assert.lengthOf(data.recovery_codes, 8)
        assert.equal(data.token_type, 'Bearer')

        const [tokenId] = data.access_token.split('|')
        const token = await db.from('personal_access_tokens').where('id', tokenId).first()
        const minutesAhead = (new Date(token.expires_at).getTime() - Date.now()) / 60000
        assert.isAbove(minutesAhead, 110)
        assert.isBelow(minutesAhead, 130)

        // Secret tersimpan terenkripsi format Laravel (Crypt::decryptString).
        const saved = await db.from('users').where('id', user.id).first()
        assert.equal(laravelEncrypter.decryptString(saved.two_factor_secret), secret)
        assert.deepEqual(
            JSON.parse(laravelEncrypter.decryptString(saved.two_factor_recovery_codes)),
            data.recovery_codes
        )

        // Setup token sekali pakai.
        const again = await client
            .post('/api/v1/auth/2fa/setup/confirm')
            .json({ setup_token: setupToken, code: otpAt(secret, currentTimestamp()) })
        again.assertStatus(410)
    })

    test('2FA terpasang: challenge, verifikasi, dan proteksi replay', async ({
        client,
        assert,
    }) => {
        const secret = generateSecretKey()
        const user = await createUser({
            two_factor_secret: laravelEncrypter.encryptString(secret),
            two_factor_confirmed_at: new Date(),
        })

        const login = async () => {
            const response = await client
                .post('/api/v1/auth/login')
                .json({ username: user.username, password: PASSWORD })
            response.assertStatus(200)
            assert.isTrue(response.body().data.requires_2fa)
            return response.body().data.challenge_token as string
        }

        const code = otpAt(secret, currentTimestamp())
        const verify = await client
            .post('/api/v1/auth/2fa/verify')
            .json({ challenge_token: await login(), code })
        verify.assertStatus(200)
        verify.assertBodyContains({ data: { user: { username: user.username } } })

        // Kode yang sama tidak bisa dipakai dua kali.
        const replay = await client
            .post('/api/v1/auth/2fa/verify')
            .json({ challenge_token: await login(), code })
        replay.assertStatus(422)
        replay.assertBodyContains({ message: 'Kode 2FA salah' })

        const expired = await client
            .post('/api/v1/auth/2fa/verify')
            .json({ challenge_token: 'tidak-ada', code })
        expired.assertStatus(410)
    })

    test('recovery code berlaku sekali', async ({ client, assert }) => {
        const user = await createUser({
            two_factor_secret: laravelEncrypter.encryptString(generateSecretKey()),
            two_factor_recovery_codes: laravelEncrypter.encryptString(
                JSON.stringify(['kode-satu1', 'kode-dua22'])
            ),
            two_factor_confirmed_at: new Date(),
        })

        const challenge = async () => {
            const response = await client
                .post('/api/v1/auth/login')
                .json({ username: user.username, password: PASSWORD })
            return response.body().data.challenge_token as string
        }

        const first = await client
            .post('/api/v1/auth/2fa/verify')
            .json({ challenge_token: await challenge(), code: 'kode-satu1' })
        first.assertStatus(200)

        const second = await client
            .post('/api/v1/auth/2fa/verify')
            .json({ challenge_token: await challenge(), code: 'kode-satu1' })
        second.assertStatus(422)

        const saved = await db.from('users').where('id', user.id).first()
        assert.deepEqual(
            JSON.parse(laravelEncrypter.decryptString(saved.two_factor_recovery_codes)),
            ['kode-dua22']
        )
    })

    test('lima kode salah membatalkan challenge (429)', async ({ client }) => {
        const user = await createUser({
            two_factor_secret: laravelEncrypter.encryptString(generateSecretKey()),
            two_factor_confirmed_at: new Date(),
        })
        const login = await client
            .post('/api/v1/auth/login')
            .json({ username: user.username, password: PASSWORD })
        const challengeToken = login.body().data.challenge_token

        for (let i = 0; i < 5; i++) {
            const response = await client
                .post('/api/v1/auth/2fa/verify')
                .json({ challenge_token: challengeToken, code: 'salah-salah' })
            response.assertStatus(422)
        }

        const blocked = await client
            .post('/api/v1/auth/2fa/verify')
            .json({ challenge_token: challengeToken, code: 'salah-salah' })
        blocked.assertStatus(429)
        blocked.assertBodyContains({ message: 'Terlalu banyak percobaan. Silakan login ulang.' })

        const gone = await client
            .post('/api/v1/auth/2fa/verify')
            .json({ challenge_token: challengeToken, code: 'salah-salah' })
        gone.assertStatus(410)
    })

    test('login dibatasi rate limit setelah 5 percobaan', async ({ client }) => {
        const user = await createUser()

        for (let i = 0; i < 5; i++) {
            const response = await client
                .post('/api/v1/auth/login')
                .json({ username: user.username, password: 'salah' })
            response.assertStatus(401)
        }

        const blocked = await client
            .post('/api/v1/auth/login')
            .json({ username: user.username, password: 'salah' })
        blocked.assertStatus(429)
    })

    test('satu akun satu sesi: login baru mengakhiri sesi lain (session_replaced)', async ({
        client,
        assert,
    }) => {
        await setTwoFactorRequired(false, null)
        const user = await createUser()

        const login = async (body: Record<string, string> = {}) => {
            const response = await client
                .post('/api/v1/auth/login')
                .json({ username: user.username, password: PASSWORD, ...body })
            return response.body().data.access_token as string
        }

        const oldToken = await login({ client: 'web_dashboard' })
        const newToken = await login({ client: 'master_app' })

        const old = await client.get('/api/v1/auth/me').bearerToken(oldToken)
        old.assertStatus(401)
        old.assertBody({
            success: false,
            message: 'Sesi Anda berakhir karena akun ini login di perangkat lain.',
            errors: { reason: 'session_replaced' },
        })

        const current = await client.get('/api/v1/auth/me').bearerToken(newToken)
        current.assertStatus(200)
        assert.lengthOf(await tokensOf(user.id), 1)
    })

    test('token tidak berlaku biasa tetap 401 tanpa alasan', async ({ client }) => {
        const response = await client.get('/api/v1/auth/me').bearerToken('999999|token-asal')

        response.assertStatus(401)
        response.assertBodyContains({ errors: null })
    })

    test('login tidak mencabut token akun layanan tanpa expires_at', async ({ client }) => {
        await setTwoFactorRequired(false, null)
        const user = await createUser()
        const plain = generateTokenString()
        const [service] = await db
            .table('personal_access_tokens')
            .insert({
                tokenable_type: LARAVEL_USER_MORPH,
                tokenable_id: user.id,
                name: 'telegram-bot-service',
                token: createHash('sha256').update(plain).digest('hex'),
                abilities: '["*"]',
                created_at: new Date(),
                updated_at: new Date(),
            })
            .returning(['id'])

        await client
            .post('/api/v1/auth/login')
            .json({ username: user.username, password: PASSWORD })

        const response = await client.get('/api/v1/auth/me').bearerToken(`${service.id}|${plain}`)
        response.assertStatus(200)
    })

    test('device_type: browser HP & APK = phone, browser komputer = computer', async ({
        client,
        assert,
    }) => {
        await setTwoFactorRequired(false, null)
        const user = await createUser()
        const latestDevice = async () => {
            const tokens = await tokensOf(user.id)
            return tokens.at(-1)?.device_type
        }

        await client
            .post('/api/v1/auth/login')
            .header('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0')
            .json({ username: user.username, password: PASSWORD })
        assert.equal(await latestDevice(), 'computer')

        await client
            .post('/api/v1/auth/login')
            .header(
                'User-Agent',
                'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36'
            )
            .json({ username: user.username, password: PASSWORD })
        assert.equal(await latestDevice(), 'phone')

        await client
            .post('/api/v1/auth/login')
            .header('User-Agent', 'okhttp/4.12.0')
            .json({ username: user.username, password: PASSWORD, client: 'master_app' })
        assert.equal(await latestDevice(), 'phone')
    })

    test('logout menutup sesi kerja, mencatat log kerja, dan menghapus token', async ({
        client,
        assert,
    }) => {
        await setTwoFactorRequired(false, null)
        const organization = await db
            .table('organizations')
            .insert({
                name: 'Site Uji',
                unique_site_code: `UJI-${randomBytes(4).toString('hex')}`,
                created_at: new Date(),
                updated_at: new Date(),
            })
            .returning(['id'])
        const user = await createUser({ organization_id: organization[0].id })
        await givePermission(user.id, 'live.broadcast')

        const login = await client
            .post('/api/v1/auth/login')
            .json({ username: user.username, password: PASSWORD })
        const token = login.body().data.access_token as string

        const [session] = await db
            .table('work_sessions')
            .insert({
                user_id: user.id,
                organization_id: organization[0].id,
                started_at: new Date(),
                last_heartbeat_at: new Date(),
                created_at: new Date(),
                updated_at: new Date(),
            })
            .returning(['id'])

        const response = await client.post('/api/v1/auth/logout').bearerToken(token)

        response.assertStatus(200)
        response.assertBody({ success: true, message: 'Berhasil logout', data: null })
        assert.lengthOf(await tokensOf(user.id), 0)

        const closed = await db.from('work_sessions').where('id', session.id).first()
        assert.isNotNull(closed.ended_at)
        assert.equal(closed.end_reason, 'logout')

        const events = await db
            .from('work_session_events')
            .where('user_id', user.id)
            .orderBy('id')
            .select('type')
        assert.deepEqual(
            events.map((event) => event.type),
            ['login', 'work_end', 'logout']
        )

        const after = await client.get('/api/v1/auth/me').bearerToken(token)
        after.assertStatus(401)
    })

    test('perubahan kewajiban 2FA tercatat di app_settings & activity_log', async ({ assert }) => {
        const root = await createUser()

        await setTwoFactorRequired(false, root.id)
        assert.isFalse(await isTwoFactorRequired())

        const setting = await db.from('app_settings').where('key', TWO_FACTOR_SETTING_KEY).first()
        assert.equal(setting.value, 'false')
        assert.equal(setting.updated_by, root.id)

        const log = await db
            .from('activity_log')
            .where('log_name', 'app_settings')
            .orderBy('id', 'desc')
            .first()
        assert.equal(log.description, `Pengaturan ${TWO_FACTOR_SETTING_KEY} diubah`)
        assert.equal(log.causer_id, root.id)
        const properties =
            typeof log.properties === 'string' ? JSON.parse(log.properties) : log.properties
        assert.deepEqual(properties, { key: TWO_FACTOR_SETTING_KEY, old: null, new: false })

        await setTwoFactorRequired(true, root.id)
        assert.isTrue(await isTwoFactorRequired())
    })
})
