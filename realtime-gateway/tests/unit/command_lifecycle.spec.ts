import { test } from '@japa/runner'
import {
    LOCATE_EXPIRY_MS,
    MAX_DELIVERY_ATTEMPTS,
    REDELIVER_AFTER_MS,
    planDispatch,
    transitionFromReport,
    type OpenCommand,
} from '#services/CommandLifecycle'

const NOW = 1_800_000_000_000

function command(overrides: Partial<OpenCommand>): OpenCommand {
    return {
        id: 1,
        deviceId: 7,
        commandType: 'lock',
        status: 'pending',
        createdAt: NOW - 1_000,
        deliveredAt: null,
        deliveryAttempts: 0,
        ...overrides,
    }
}

const online = () => true
const offline = () => false

test.group('Perintah device: rencana kirim', () => {
    test('perintah pending dikirim hanya saat HP online', ({ assert }) => {
        const commands = [command({ id: 1 })]
        assert.deepEqual(planDispatch(commands, NOW, online).send, [1])
        assert.deepEqual(planDispatch(commands, NOW, offline), { send: [], expire: [], fail: [] })
    })

    test('lock lama yang belum sampai tidak kedaluwarsa (HP baru menyala seminggu kemudian)', ({
        assert,
    }) => {
        const old = command({ id: 1, createdAt: NOW - 7 * 24 * 60 * 60 * 1000 })
        assert.deepEqual(planDispatch([old], NOW, online).send, [1])
    })

    test('lock/unlock lama digantikan yang terbaru, hanya yang terbaru dikirim', ({ assert }) => {
        const plan = planDispatch(
            [
                command({ id: 1, commandType: 'lock' }),
                command({ id: 2, commandType: 'unlock' }),
                command({ id: 3, commandType: 'locate_now' }),
                command({ id: 4, deviceId: 8, commandType: 'lock' }),
            ],
            NOW,
            online
        )
        assert.deepEqual(plan.send, [2, 3, 4])
        assert.deepEqual(
            plan.expire.map((item) => item.id),
            [1]
        )
    })

    test('locate_now basi dibatalkan walau HP offline', ({ assert }) => {
        const plan = planDispatch(
            [command({ commandType: 'locate_now', createdAt: NOW - LOCATE_EXPIRY_MS - 1 })],
            NOW,
            offline
        )
        assert.lengthOf(plan.expire, 1)
        assert.lengthOf(plan.send, 0)
    })

    test('delivered tanpa konfirmasi dikirim ulang setelah jeda, lalu gagal setelah batas', ({
        assert,
    }) => {
        const fresh = command({
            status: 'delivered',
            deliveredAt: NOW - 1_000,
            deliveryAttempts: 1,
        })
        assert.deepEqual(planDispatch([fresh], NOW, online).send, [])

        const stale = { ...fresh, deliveredAt: NOW - REDELIVER_AFTER_MS }
        assert.deepEqual(planDispatch([stale], NOW, online).send, [1])

        const exhausted = { ...stale, deliveryAttempts: MAX_DELIVERY_ATTEMPTS }
        const plan = planDispatch([exhausted], NOW, online)
        assert.deepEqual(plan.send, [])
        assert.deepEqual(
            plan.fail.map((item) => item.id),
            [1]
        )

        // HP offline: tidak dihitung gagal, tetap menunggu.
        assert.deepEqual(planDispatch([exhausted], NOW, offline).fail, [])
    })
})

test.group('Perintah device: laporan HP', () => {
    test('APK lama (tanpa result) hanya memajukan delivered -> acknowledged', ({ assert }) => {
        assert.deepEqual(transitionFromReport('delivered', {}), {
            status: 'acknowledged',
            message: null,
        })
        assert.isNull(transitionFromReport('pending', {}))
        assert.isNull(transitionFromReport('acknowledged', {}))
    })

    test('hasil dijalankan/gagal diterima dari delivered atau acknowledged saja', ({ assert }) => {
        assert.deepEqual(
            transitionFromReport('acknowledged', {
                result: 'executed',
                message: ' Layar dikunci ',
            }),
            { status: 'executed', message: 'Layar dikunci' }
        )
        assert.deepEqual(transitionFromReport('delivered', { result: 'failed', message: 42 }), {
            status: 'failed',
            message: null,
        })
        assert.isNull(transitionFromReport('pending', { result: 'executed' }))
        assert.isNull(transitionFromReport('executed', { result: 'failed' }))
        assert.isNull(transitionFromReport('expired', { result: 'executed' }))
        assert.isNull(transitionFromReport('delivered', { result: 'hapus-semua' }))
    })

    test('pesan hasil dipotong 255 karakter', ({ assert }) => {
        const result = transitionFromReport('acknowledged', {
            result: 'failed',
            message: 'x'.repeat(400),
        })
        assert.equal(result?.message?.length, 255)
    })
})

test.group('Perintah device: pesan hasil dari HP', () => {
    test('karakter kontrol (baris baru, ANSI) dibuang dari pesan', ({ assert }) => {
        const result = transitionFromReport('acknowledged', {
            result: 'failed',
            message: 'Gagal\r\n\u001b[31mmerah\u0000',
        })
        assert.equal(result?.message, 'Gagal[31mmerah')
    })

    test('pesan yang isinya hanya karakter kontrol dianggap kosong', ({ assert }) => {
        const result = transitionFromReport('acknowledged', {
            result: 'executed',
            message: ' \n\t ',
        })
        assert.isNull(result?.message)
    })
})
