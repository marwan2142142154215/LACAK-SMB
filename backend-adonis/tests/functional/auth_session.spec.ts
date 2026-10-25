import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import PersonalAccessToken from '#models/personal_access_token'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'

/** User + token Sanctum persis seperti yang dibuat backend-api. */
async function userWithToken(expiresAt: DateTime | null = DateTime.now().plus({ hours: 2 })) {
    const suffix = randomBytes(4).toString('hex')
    const [user] = await db
        .table('users')
        .insert({
            username: `uji.adonis.${suffix}`,
            name: 'Uji Adonis',
            email: `uji.adonis.${suffix}@example.test`,
            password: '$2y$10$Y18XUtkwVNaSkDxG0mGKX.51ec8i1y3rdvE4Cc.QSg9izFzIo/CiO',
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])

    const plain = randomBytes(20).toString('hex')
    const token = await PersonalAccessToken.create({
        tokenableType: LARAVEL_USER_MORPH,
        tokenableId: user.id,
        name: `web_dashboard-${Date.now()}`,
        deviceType: 'computer',
        token: createHash('sha256').update(plain).digest('hex'),
        abilities: '["*"]',
        expiresAt,
    })

    return { userId: user.id as number, token, bearer: `${token.id}|${plain}` }
}

test.group('Auth: token Sanctum dari backend-api', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('GET /auth/me menerima token Laravel dan menggeser idle timeout', async ({
        client,
        assert,
    }) => {
        const { userId, token, bearer } = await userWithToken(DateTime.now().plus({ minutes: 5 }))

        const response = await client.get('/api/v1/auth/me').bearerToken(bearer)

        response.assertStatus(200)
        response.assertBodyContains({ success: true, data: { id: userId, roles: [] } })
        await token.refresh()
        assert.isNotNull(token.lastUsedAt)
        assert.isAbove(
            token.expiresAt!.toMillis(),
            DateTime.now().plus({ minutes: 110 }).toMillis()
        )
    })

    test('GET /auth/session tidak memperpanjang token', async ({ client, assert }) => {
        const expiresAt = DateTime.now().plus({ minutes: 5 }).startOf('second')
        const { token, bearer } = await userWithToken(expiresAt)

        const response = await client.get('/api/v1/auth/session').bearerToken(bearer)

        response.assertStatus(200)
        await token.refresh()
        assert.equal(token.expiresAt!.toMillis(), expiresAt.toMillis())
    })

    test('token akun layanan tanpa expires_at tetap tanpa batas', async ({ client, assert }) => {
        const { token, bearer } = await userWithToken(null)

        const response = await client.get('/api/v1/auth/me').bearerToken(bearer)

        response.assertStatus(200)
        await token.refresh()
        assert.isNull(token.expiresAt)
    })

    test('token kedaluwarsa, salah, atau tanpa token dibalas 401 seperti Laravel', async ({
        client,
    }) => {
        const expired = await userWithToken(DateTime.now().minus({ minutes: 1 }))
        const valid = await userWithToken()
        const unauthorized = {
            success: false,
            message: 'Belum masuk atau token tidak berlaku',
            errors: null,
        }

        for (const request of [
            client.get('/api/v1/auth/me').bearerToken(expired.bearer),
            client.get('/api/v1/auth/me').bearerToken(`${valid.token.id}|salah`),
            client.get('/api/v1/auth/me'),
        ]) {
            const response = await request
            response.assertStatus(401)
            response.assertBody(unauthorized)
        }
    })

    test('user yang di-soft-delete tidak bisa masuk', async ({ client }) => {
        const { userId, bearer } = await userWithToken()
        await db.from('users').where('id', userId).update({ deleted_at: new Date() })

        const response = await client.get('/api/v1/auth/me').bearerToken(bearer)

        response.assertStatus(401)
    })
})

test.group('CORS', () => {
    /** Regresi: dulu CORS menolak semua origin di luar mode development -- login dashboard gagal di produksi. */
    test('preflight dari dashboard diizinkan seperti Laravel (origin *, tanpa credentials)', async ({
        client,
        assert,
    }) => {
        const response = await client
            .options('/api/v1/auth/login')
            .header('Origin', 'https://app.salahmu.fun')
            .header('Access-Control-Request-Method', 'POST')
            .header('Access-Control-Request-Headers', 'content-type,authorization')

        assert.equal(response.header('access-control-allow-origin'), '*')
        assert.include(response.header('access-control-allow-methods'), 'POST')
        assert.isUndefined(response.header('access-control-allow-credentials'))
    })
})
