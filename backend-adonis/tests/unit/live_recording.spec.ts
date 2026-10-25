import { createHash, createHmac } from 'node:crypto'
import { test } from '@japa/runner'
import { recordingEnabled, recordingPath, verifyWebhook } from '#services/recording'

// Sama dengan LIVEKIT_API_KEY / LIVEKIT_API_SECRET di .env.test.
const API_KEY = 'kunci-uji'
const API_SECRET = 'r'.repeat(40)

/** Token webhook seperti yang dikirim LiveKit: JWT HS256 + klaim sha256 body. */
function webhookToken(body: string, overrides: Record<string, unknown> = {}, secret = API_SECRET) {
    const now = Math.floor(Date.now() / 1000)
    const claims = {
        iss: API_KEY,
        nbf: now,
        exp: now + 300,
        sha256: createHash('sha256').update(body).digest('base64'),
        ...overrides,
    }
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`
    const signature = createHmac('sha256', secret).update(unsigned).digest('base64url')
    return `${unsigned}.${signature}`
}

test.group('Rekaman Live Kerja: webhook LiveKit', () => {
    const body = JSON.stringify({ event: 'track_published', room: { name: 'site-1' } })

    test('token sah dari LiveKit diterima', ({ assert }) => {
        assert.isTrue(verifyWebhook(body, webhookToken(body)))
        assert.isTrue(verifyWebhook(body, `Bearer ${webhookToken(body)}`))
    })

    test('body diubah, secret lain, api key lain, atau kedaluwarsa ditolak', ({ assert }) => {
        assert.isFalse(verifyWebhook(body.replace('site-1', 'site-2'), webhookToken(body)))
        assert.isFalse(verifyWebhook(body, webhookToken(body, {}, 'x'.repeat(40))))
        assert.isFalse(verifyWebhook(body, webhookToken(body, { iss: 'kunci-lain' })))
        assert.isFalse(
            verifyWebhook(body, webhookToken(body, { exp: Math.floor(Date.now() / 1000) - 600 }))
        )
        assert.isFalse(verifyWebhook(body, undefined))
        assert.isFalse(verifyWebhook(body, 'bukan.jwt'))
    })
})

test.group('Rekaman Live Kerja: penyimpanan', () => {
    test('path file per site, staf, tanggal & sumber', ({ assert }) => {
        assert.equal(
            recordingPath(3, 42, 'screen_share', 'TR_abc', new Date('2026-10-25T07:05:09Z')),
            'recordings/3/42/2026-10-25/screen_share-070509-TR_abc.webm'
        )
    })

    test('rekaman mati selama Spaces belum diisi', ({ assert }) => {
        assert.isFalse(recordingEnabled())
    })
})
