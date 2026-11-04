import { createHash, createHmac } from 'node:crypto'
import { test } from '@japa/runner'
import {
    recordingEnabled,
    recordingPath,
    staffFolderName,
    totalTooShort,
    verifyWebhook,
    withinSessionLimit,
} from '#services/Recording'
import { spacesKey, spacesPrefix, stripSpacesPrefix } from '#services/Storage'

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
    test('path file per tanggal kantor, nama staf & sumber', ({ assert }) => {
        assert.equal(
            recordingPath(
                'Budi Santoso',
                42,
                'screen_share',
                'TR_abc',
                new Date('2026-10-25T07:05:09Z')
            ),
            'recordings/2026-10-25/Budi_Santoso/screen_share-140509-TR_abc.webm'
        )
    })

    test('tanggal mengikuti waktu kantor, bukan UTC (lewat tengah malam)', ({ assert }) => {
        assert.equal(
            recordingPath('Ani', 1, 'camera', 'TR_x', new Date('2026-11-03T17:30:00Z')),
            'recordings/2026-11-04/Ani/camera-003000-TR_x.webm'
        )
    })

    test('nama folder staf dibersihkan dan aman sebagai kunci objek', ({ assert }) => {
        assert.equal(staffFolderName('  Rizky / Pratama  ', 7), 'Rizky_Pratama')
        assert.equal(staffFolderName('José Núñez', 7), 'Jose_Nunez')
        assert.equal(staffFolderName('../..', 7), 'user-7')
        assert.equal(staffFolderName('', 7), 'user-7')
        assert.isAtMost(staffFolderName('a'.repeat(100), 1).length, 40)
    })

    test('rekaman mati selama Spaces belum diisi', ({ assert }) => {
        assert.isFalse(recordingEnabled())
    })
})

test.group('Penyimpanan Spaces: folder khusus proyek', () => {
    test('kunci objek selalu diawali folder lacaklive', ({ assert }) => {
        assert.equal(spacesPrefix(), 'lacaklive')
        assert.equal(spacesKey('recordings/1/2/x.webm'), 'lacaklive/recordings/1/2/x.webm')
        assert.equal(spacesKey('/apk-builds/3/a.apk'), 'lacaklive/apk-builds/3/a.apk')
    })

    test('stripSpacesPrefix membalik spacesKey dan membiarkan path tanpa awalan', ({ assert }) => {
        const path = 'chat/5/abc.png'
        assert.equal(stripSpacesPrefix(spacesKey(path)), path)
        assert.equal(stripSpacesPrefix(path), path)
    })
})

test.group('Batas rekaman Live Kerja', () => {
    test('rekaman berjalan sampai 14 jam sejak sesi mulai, lewat tengah malam pun', ({
        assert,
    }) => {
        const start = new Date('2026-11-03T20:00:00Z')
        assert.isTrue(withinSessionLimit(start, new Date('2026-11-04T09:59:00Z')))
        assert.isFalse(withinSessionLimit(start, new Date('2026-11-04T10:00:00Z')))
    })

    test('total rekaman sesi < 1 jam dibuang, >= 1 jam disimpan', ({ assert }) => {
        assert.isTrue(totalTooShort(0))
        assert.isTrue(totalTooShort(59 * 60 + 59))
        assert.isFalse(totalTooShort(60 * 60))
        assert.isFalse(totalTooShort(40 * 60 + 50 * 60))
    })
})
