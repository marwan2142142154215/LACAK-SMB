import { test } from '@japa/runner'
import {
    imageErrors,
    laravelTrim,
    sniffImage,
    strLimit,
    toPayload,
} from '#controllers/chat_messages_controller'
import {
    carbonBinding,
    dataChangeSentence,
    deviceLabel,
    fieldChanges,
    payload,
    safeValues,
    searchPattern,
    subjectName,
    validate,
    type ActivityRow,
} from '#controllers/activity_logs_controller'
import {
    ACTIONS,
    activityOrganizationId,
    MODEL_MORPHS,
    normalizeInput,
    resultOf,
    safeInput,
    strimwidth,
} from '#middleware/record_api_activity_middleware'
import {
    formatBytes,
    heartbeatStatus,
    livekitHttpUrl,
    overallStatus,
    parseUnits,
    probeOk,
    queueVerdict,
    storageVerdict,
    unitStatuses,
} from '#services/server_status'
import { laravelUrlSigner } from '#services/laravel/index'

/** PNG 800x600 minimal (signature + IHDR). */
function png(width: number, height: number) {
    const buffer = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
    buffer.writeUInt32BE(13, 8)
    buffer.write('IHDR', 12, 'latin1')
    buffer.writeUInt32BE(width, 16)
    buffer.writeUInt32BE(height, 20)
    return buffer
}

/** JPEG minimal: SOI, APP0 kosong, SOF0 dengan ukuran. */
function jpeg(width: number, height: number) {
    const sof = Buffer.alloc(19)
    sof.writeUInt16BE(0xffc0, 0)
    sof.writeUInt16BE(17, 2)
    sof[4] = 8
    sof.writeUInt16BE(height, 5)
    sof.writeUInt16BE(width, 7)
    return Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
        sof,
        Buffer.from([0xff, 0xd9]),
    ])
}

test.group('Chat: gambar & payload', () => {
    test('jenis & ukuran gambar dibaca dari isi berkas', ({ assert }) => {
        assert.deepEqual(sniffImage(png(800, 600)), {
            mime: 'image/png',
            extension: 'png',
            width: 800,
            height: 600,
        })
        assert.deepEqual(sniffImage(jpeg(1024, 768)), {
            mime: 'image/jpeg',
            extension: 'jpg',
            width: 1024,
            height: 768,
        })

        const gif = Buffer.alloc(13)
        gif.write('GIF89a', 0, 'latin1')
        gif.writeUInt16LE(320, 6)
        gif.writeUInt16LE(200, 8)
        assert.deepEqual(sniffImage(gif), {
            mime: 'image/gif',
            extension: 'gif',
            width: 320,
            height: 200,
        })

        const webp = Buffer.alloc(30)
        webp.write('RIFF', 0, 'latin1')
        webp.write('WEBP', 8, 'latin1')
        webp.write('VP8X', 12, 'latin1')
        webp.writeUIntLE(639, 24, 3)
        webp.writeUIntLE(479, 27, 3)
        assert.deepEqual(sniffImage(webp), {
            mime: 'image/webp',
            extension: 'webp',
            width: 640,
            height: 480,
        })
    })

    test('SVG ditolak dengan pesan validasi Laravel', ({ assert }) => {
        const svg = Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        )
        assert.isNull(sniffImage(svg))
        assert.deepEqual(imageErrors(svg), [
            'The image field must be a file of type: jpg, jpeg, png, webp, gif.',
            'The image field must be a file of type: image/jpeg, image/png, image/webp, image/gif.',
            'The image field has invalid image dimensions.',
        ])
        assert.deepEqual(imageErrors(png(800, 600)), [])
        assert.deepEqual(imageErrors(png(10_001, 10)), [
            'The image field has invalid image dimensions.',
        ])
    })

    test('Str::limit 140 & TrimStrings', ({ assert }) => {
        assert.equal(strLimit('pendek', 140), 'pendek')
        assert.equal(strLimit('a'.repeat(139) + ' bcd', 140), 'a'.repeat(139) + '...')
        assert.equal(strLimit('漢'.repeat(71), 140), '漢'.repeat(70) + '...')
        assert.equal(laravelTrim('​  Halo tim  \n'), 'Halo tim')
    })

    test('payload pesan sama dengan ChatMessage::toPayload()', ({ assert }) => {
        const now = new Date('2026-10-25T03:00:00Z')
        const row = {
            id: 7,
            organization_id: 3,
            user_id: 9,
            user_name: 'Sari',
            reply_to_id: 5,
            body: null,
            image_path: 'chat/3/x.jpg',
            image_mime: 'image/jpeg',
            image_width: 800,
            image_height: 600,
            created_at: new Date('2026-10-25T03:45:45Z'),
            reply_id: 5,
            reply_user_name: 'Budi',
            reply_body: 'Siapa yang pegang kunci gudang?',
            reply_image_path: null,
        }
        const data = toPayload(row, now)

        assert.equal(data.created_at, '2026-10-25T03:45:45.000000Z')
        assert.notProperty(data, 'image_path')
        assert.deepEqual(data.reply_to, {
            id: 5,
            user_name: 'Budi',
            body: 'Siapa yang pegang kunci gudang?',
            has_image: false,
        })
        const url = new URL(data.image!.url)
        assert.equal(url.pathname, '/api/v1/chat-messages/7/image')
        assert.equal(url.searchParams.get('expires'), String(now.getTime() / 1000 + 12 * 3600))
        assert.isTrue(
            laravelUrlSigner.hasValidSignature(
                url.pathname,
                Object.fromEntries(url.searchParams),
                now
            )
        )

        // Pesan asal sudah terhapus (reply_to_id masih ada tapi relasinya null).
        assert.isNull(toPayload({ ...row, reply_id: null }, now).reply_to)
    })
})

const activity = (overrides: Partial<ActivityRow>): ActivityRow => ({
    id: 1,
    log_name: 'api',
    description: 'Mengubah device HP Kasir',
    subject_type: MODEL_MORPHS.Device,
    subject_id: 4,
    event: 'DeviceController@update',
    causer_type: 'App\\Models\\User',
    causer_id: 2,
    properties: {
        category: 'device',
        status: 200,
        result: 'ok',
        message: null,
        input: { device_name: 'HP Kasir Depan' },
        route: 'PUT /api/v1/devices/4',
    },
    batch_uuid: 'b1',
    organization_id: 3,
    ip_address: '127.0.0.1',
    user_agent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
    created_at: new Date('2026-10-25T03:45:45Z'),
    subject: null,
    causer: { id: 2, name: 'Admin', username: 'admin.a' },
    ...overrides,
})

test.group('Log aktivitas: payload', () => {
    test('aksi API dengan rincian perubahan dari batch yang sama', ({ assert }) => {
        const change = activity({
            id: 2,
            log_name: 'default',
            description: 'updated',
            event: 'updated',
            properties: {
                attributes: { device_name: 'HP Kasir Depan', secret_hash: 'x' },
                old: { device_name: 'HP Kasir', secret_hash: 'y' },
            },
        })
        const entry = payload(
            activity({ subject: { id: 4, device_name: 'HP Kasir Depan', organization_id: 3 } }),
            new Map([['b1', [change]]]),
            new Map([[3, 'Gudang Utama']])
        )

        assert.equal(entry.at, '2026-10-25T03:45:45+00:00')
        assert.equal(entry.device, 'Chrome · Windows')
        assert.deepEqual(entry.organization, { id: 3, name: 'Gudang Utama' })
        assert.deepEqual(entry.subject, { type: 'Device', name: 'HP Kasir Depan' })
        assert.deepEqual(entry.changes, [
            {
                type: 'Device',
                name: 'HP Kasir Depan',
                event: 'updated',
                fields: [
                    { field: 'device_name', old: 'HP Kasir', new: 'HP Kasir Depan' },
                    { field: 'secret_hash', old: '••••', new: '••••' },
                ],
            },
        ])
    })

    test('pelaku terhapus, perubahan data di luar API, input aman', ({ assert }) => {
        const entry = payload(
            activity({
                log_name: 'default',
                event: 'deleted',
                causer: null,
                subject_type: MODEL_MORPHS.User,
                subject_id: 12,
                properties: { old: { username: 'budi' } },
                batch_uuid: null,
            }),
            new Map(),
            new Map()
        )
        assert.equal(entry.category, 'data')
        assert.equal(entry.description, 'Staf budi dihapus')
        assert.deepEqual(entry.causer, { id: 2, name: 'Akun terhapus', username: null })
        assert.deepEqual(entry.input, [])

        assert.equal(
            dataChangeSentence(
                activity({ event: 'created', subject_type: null, subject_id: null, properties: {} })
            ),
            'Data  dibuat'
        )
        assert.equal(subjectName(activity({ properties: {}, subject: null })), '#4')
        assert.deepEqual(safeValues({ username: 'a', password: 'b' }), { username: 'a' })
        assert.deepEqual(safeValues({ token: 'x' }), [])
        assert.deepEqual(fieldChanges(activity({ properties: null })), [])
    })

    test('label perangkat dari user agent', ({ assert }) => {
        assert.equal(deviceLabel('okhttp/4.12.0'), 'Aplikasi Android')
        assert.equal(deviceLabel('axios/1.7.2'), 'Server / bot')
        assert.equal(
            deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1'),
            'Safari · iOS'
        )
        assert.equal(
            deviceLabel('Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0'),
            'Firefox · Linux'
        )
        assert.isNull(deviceLabel(null))
    })

    test('validasi filter & binding tanggal seperti Carbon::parse', ({ assert }) => {
        assert.equal(carbonBinding('2026-10-24T17:00:00.000Z'), '2026-10-24 17:00:00')
        assert.equal(carbonBinding('2026-10-25T00:00:00+07:00'), '2026-10-25 00:00:00')
        assert.equal(carbonBinding('2026-10-25 08:30:00'), '2026-10-25 08:30:00')
        assert.isNull(carbonBinding('bukan tanggal'))

        assert.deepEqual(validate({ result: 'x', organization_id: 'abc', from: 'kemarin' }), {
            errors: {
                organization_id: ['The organization id field must be an integer.'],
                from: ['The from field must be a valid date.'],
                result: ['The selected result is invalid.'],
            },
        })
        const ok = validate({
            category: '0',
            search: '  budi ',
            before_id: '0',
            organization_id: '',
        })
        assert.deepEqual(ok, {
            filters: {
                organizationId: null,
                from: null,
                to: null,
                category: null,
                result: null,
                search: 'budi',
                beforeId: null,
            },
        })
        assert.equal(searchPattern('Budi_50%'), '%budi\\_50\\%%')
    })
})

test.group('Log aktivitas: middleware RecordApiActivity', () => {
    test('kalimat aksi sama dengan backend-api', ({ assert }) => {
        const device = { id: 4, device_name: 'HP Kasir', organization_id: 3 }

        assert.equal(
            ACTIONS['PUT /api/v1/devices/:device'].describe({}, device, 200, null),
            'Mengubah device HP Kasir'
        )
        assert.equal(ACTIONS['PATCH /api/v1/devices/:device'].action, 'DeviceController@update')
        assert.equal(
            ACTIONS['POST /api/v1/devices/:device/commands'].describe(
                { command_type: 'lock', reason_note: 'x'.repeat(100) },
                device,
                201,
                null
            ),
            `Mengunci HP Kasir — ${'x'.repeat(79)}…`
        )
        assert.equal(
            ACTIONS['POST /api/v1/auth/login'].describe({ username: ' budi ' }, null, 401, null),
            'Login gagal: username atau password salah (budi)'
        )
        assert.equal(
            ACTIONS['POST /api/v1/auth/login'].describe({}, null, 200, { requires_2fa: true }),
            'Password benar, menunggu kode 2FA'
        )
        assert.equal(
            ACTIONS['PUT /api/v1/users/:user'].describe(
                { role: 'site_admin' },
                { id: 1, username: 'sari' },
                200,
                null
            ),
            'Mengubah data staf sari (peran: Admin Site)'
        )
        assert.equal(
            ACTIONS['POST /api/v1/apk-builds/generate'].describe(
                { apk_type: 'tracker', version: '1.2.0', device_name: 'HP Gudang' },
                null,
                201,
                null
            ),
            'Membuat build SMB Pelacak v1.2.0 untuk HP Gudang'
        )
        assert.equal(
            ACTIONS['PUT /api/v1/settings/security'].describe(
                { two_factor_required: 'true' },
                null,
                200,
                null
            ),
            'Menyalakan 2FA wajib untuk semua akun'
        )
        assert.equal(Object.keys(ACTIONS).length, 39)
    })

    test('input aman, hasil, site catatan', ({ assert }) => {
        const input = normalizeInput({
            username: '  budi ',
            password: ' rahasia ',
            name: '',
            organization_id: '5',
        }) as Record<string, unknown>
        assert.deepEqual(safeInput(input), { username: 'budi', organization_id: '5' })
        assert.deepEqual(safeInput({ password: 'x' }), [])
        assert.equal(input.password, ' rahasia ')

        assert.equal(resultOf(201), 'ok')
        assert.equal(resultOf(403), 'denied')
        assert.equal(resultOf(500), 'failed')
        assert.equal(strimwidth('abc', 200), 'abc')

        assert.equal(activityOrganizationId({ model: 'Organization', row: { id: 8 } }, [], null), 8)
        assert.equal(
            activityOrganizationId(
                { model: 'Device', row: { id: 1, organization_id: 3 } },
                [],
                null
            ),
            3
        )
        assert.equal(
            activityOrganizationId(null, { organization_id: '5' }, { id: 1, organization_id: 2 }),
            5
        )
        assert.equal(activityOrganizationId(null, [], { id: 1, organization_id: 2 }), 2)
        assert.isNull(activityOrganizationId(null, [], null))
    })

    test('nama model Laravel memakai satu backslash', ({ assert }) => {
        assert.equal(MODEL_MORPHS.Device, ['App', 'Models', 'Device'].join(String.fromCharCode(92)))
    })
})

test.group('Status server', () => {
    test('detak scheduler & antrean', ({ assert }) => {
        const now = new Date('2026-10-25T03:10:00Z')
        assert.equal(heartbeatStatus(null, now), 'unknown')
        assert.equal(heartbeatStatus('2026-10-25T03:09:00+00:00', now), 'ok')
        assert.equal(heartbeatStatus('2026-10-25T03:05:00+00:00', now), 'warn')
        assert.equal(heartbeatStatus('2026-10-25T02:55:00+00:00', now), 'down')

        assert.deepEqual(queueVerdict('ok', false, 2, 1), [
            'ok',
            'Worker memproses job · 2 menunggu · 1 gagal',
        ])
        assert.deepEqual(queueVerdict('down', true, null, null), [
            'warn',
            'Sedang memproses build APK — job lain menunggu',
        ])
        assert.equal(queueVerdict('unknown', true, null, null)[0], 'warn')
        assert.deepEqual(queueVerdict('unknown', false, null, null), [
            'unknown',
            'Belum ada job yang diproses. Pastikan layanan lacak-queue dan lacak-scheduler aktif.',
        ])
    })

    test('gateway, livekit, disk, unit systemd, status keseluruhan', ({ assert }) => {
        assert.isTrue(probeOk('gateway', 200, { data: { status: 'ok' } }))
        assert.isFalse(probeOk('gateway', 200, null))
        assert.isFalse(probeOk('livekit', 502, null))
        assert.isTrue(probeOk('livekit', 200, null))
        assert.equal(livekitHttpUrl('wss://live.test'), 'https://live.test')
        assert.isNull(livekitHttpUrl(''))

        assert.equal(formatBytes(0), '0 B')
        assert.equal(formatBytes(1536), '1.5 KB')
        assert.equal(formatBytes(12 * 1024 ** 3), '12 GB')
        assert.deepEqual(storageVerdict(5, 100), ['warn', 'Sisa 5 B dari 100 B (5%)'])
        assert.equal(storageVerdict(2, 100)[0], 'down')

        assert.deepEqual(parseUnits(' lacak-gateway, ,lacak-queue '), [
            'lacak-gateway',
            'lacak-queue',
        ])
        assert.deepEqual(unitStatuses(['a', 'b', 'c'], 'active\nfailed\n'), [
            { name: 'a', state: 'active', status: 'ok' },
            { name: 'b', state: 'failed', status: 'down' },
            { name: 'c', state: 'unknown', status: 'unknown' },
        ])

        assert.equal(overallStatus(['ok', 'unknown']), 'ok')
        assert.equal(overallStatus(['ok', 'warn']), 'warn')
        assert.equal(overallStatus(['warn', 'down']), 'down')
    })
})
