import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createApiAdapter, createPageScope, isPageScoped, ttlFor } from './apiCache.js'

/** Adapter palsu: menghitung panggilan dan mengembalikan teks JSON mentah seperti adapter axios asli. */
function fakeBase(handler = () => ({ ok: true })) {
    const calls = []
    const base = async (config) => {
        calls.push(config)
        const body = await handler(config, calls.length)
        return { data: JSON.stringify(body), status: 200, statusText: 'OK', headers: {}, request: {} }
    }
    return { base, calls }
}

const get = (url, extra = {}) => ({ method: 'get', url, headers: { Authorization: 'Bearer a' }, ...extra })

describe('cache GET', () => {
    it('memakai ulang hasil selama TTL dan mengambil lagi setelahnya', async () => {
        let clock = 1_000
        const { base, calls } = fakeBase()
        const adapter = createApiAdapter(base, { now: () => clock })

        await adapter(get('/devices'))
        await adapter(get('/devices'))
        assert.equal(calls.length, 1)

        clock += 21_000
        await adapter(get('/devices'))
        assert.equal(calls.length, 2)
    })

    it('menggabungkan panggilan identik yang bersamaan jadi satu permintaan', async () => {
        const { base, calls } = fakeBase(() => new Promise((resolve) => setTimeout(() => resolve({ n: 1 }), 5)))
        const adapter = createApiAdapter(base)

        const results = await Promise.all([adapter(get('/sites')), adapter(get('/devices')), adapter(get('/devices'))])
        assert.equal(calls.length, 2)
        assert.equal(results[1].data, results[2].data)
    })

    it('parameter dan token berbeda tidak berbagi cache', async () => {
        const { base, calls } = fakeBase()
        const adapter = createApiAdapter(base)

        await adapter(get('/devices', { params: { per_page: 10 } }))
        await adapter(get('/devices', { params: { per_page: 500 } }))
        await adapter({ ...get('/devices', { params: { per_page: 10 } }), headers: { Authorization: 'Bearer b' } })
        assert.equal(calls.length, 3)

        await adapter(get('/devices', { params: { per_page: 10 } }))
        assert.equal(calls.length, 3)
    })

    it('urutan parameter tidak mengubah kunci', async () => {
        const { base, calls } = fakeBase()
        const adapter = createApiAdapter(base)

        await adapter(get('/users', { params: { a: 1, b: 2 } }))
        await adapter(get('/users', { params: { b: 2, a: 1 } }))
        assert.equal(calls.length, 1)
    })

    it('tiap pemanggil mendapat teks mentah yang sama sehingga mengubah hasil tidak merusak yang lain', async () => {
        const { base } = fakeBase(() => ({ items: [1, 2, 3] }))
        const adapter = createApiAdapter(base)

        const first = JSON.parse((await adapter(get('/devices'))).data)
        first.items.push(99)
        const second = JSON.parse((await adapter(get('/devices'))).data)
        assert.deepEqual(second.items, [1, 2, 3])
    })

    it('config yang dipakai adalah milik pemanggil, bukan milik permintaan pertama', async () => {
        const { base } = fakeBase()
        const adapter = createApiAdapter(base)

        await adapter(get('/devices'))
        const mine = get('/devices')
        const response = await adapter(mine)
        assert.equal(response.config, mine)
    })

    it('kegagalan tidak disimpan', async () => {
        let fail = true
        const { base, calls } = fakeBase(() => {
            if (fail) throw new Error('gagal')
            return { ok: true }
        })
        const adapter = createApiAdapter(base)

        await assert.rejects(adapter(get('/devices')))
        fail = false
        await adapter(get('/devices'))
        assert.equal(calls.length, 2)
    })

    it('fresh: true mengabaikan cache tetapi memperbaruinya', async () => {
        const { base, calls } = fakeBase((_config, n) => ({ n }))
        const adapter = createApiAdapter(base)

        await adapter(get('/devices'))
        const fresh = await adapter(get('/devices', { fresh: true }))
        assert.equal(JSON.parse(fresh.data).n, 2)
        const cached = await adapter(get('/devices'))
        assert.equal(JSON.parse(cached.data).n, 2)
        assert.equal(calls.length, 2)
    })

    it('endpoint yang tidak ada di daftar tidak pernah di-cache', async () => {
        const { base, calls } = fakeBase()
        const adapter = createApiAdapter(base)

        await adapter(get('/chat/groups'))
        await adapter(get('/chat/groups'))
        await adapter(get('/staff-locations'))
        await adapter(get('/staff-locations'))
        assert.equal(calls.length, 4)
    })

    it('briefing with_people (dipolling halamannya) tidak di-cache, daftar biasa di-cache', async () => {
        const { base, calls } = fakeBase()
        const adapter = createApiAdapter(base)

        await adapter(get('/briefings', { params: { with_people: 1 } }))
        await adapter(get('/briefings', { params: { with_people: 1 } }))
        await adapter(get('/briefings'))
        await adapter(get('/briefings'))
        assert.equal(calls.length, 3)
    })
})

describe('tulis mengosongkan cache', () => {
    it('POST biasa mengosongkan semua', async () => {
        const { base, calls } = fakeBase()
        const adapter = createApiAdapter(base)

        await adapter(get('/devices'))
        await adapter(get('/organizations/mine'))
        await adapter({ method: 'post', url: '/devices/5/lock', headers: {} })
        await adapter(get('/devices'))
        await adapter(get('/organizations/mine'))
        assert.equal(calls.length, 5)
    })

    it('tulis rutin Live hanya menghapus data ringkasan Live', async () => {
        const { base, calls } = fakeBase()
        const adapter = createApiAdapter(base)

        await adapter(get('/organizations/mine'))
        await adapter(get('/live/overview'))
        await adapter({ method: 'post', url: '/live/sessions/heartbeat', headers: {} })
        await adapter(get('/organizations/mine'))
        await adapter(get('/live/overview'))
        assert.equal(calls.length, 4)
    })

    it('hasil baca yang dimulai sebelum tulis tidak masuk cache', async () => {
        let release
        const gate = new Promise((resolve) => (release = resolve))
        const { base, calls } = fakeBase(async (config) => {
            if (config.url === '/devices' && calls.length === 1) await gate
            return { ok: true }
        })
        const adapter = createApiAdapter(base)

        const slowRead = adapter(get('/devices'))
        await adapter({ method: 'put', url: '/devices/1', headers: {} })
        release()
        await slowRead
        await adapter(get('/devices'))
        assert.equal(calls.length, 3)
    })
})

describe('pembatalan saat pindah menu', () => {
    const abortable = (calls) => (config) =>
        new Promise((_resolve, reject) => {
            calls.push(config)
            config.signal.addEventListener('abort', () =>
                reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED', name: 'CanceledError' })),
            )
        })

    it('leave() membatalkan GET halaman dan hasilnya tidak pernah selesai', async () => {
        const calls = []
        const pageScope = createPageScope()
        const adapter = createApiAdapter(abortable(calls), { pageScope })

        let settled = false
        adapter(get('/activity-logs')).then(
            () => (settled = true),
            () => (settled = true),
        )
        pageScope.leave()
        await new Promise((resolve) => setTimeout(resolve, 10))
        assert.equal(calls[0].signal.aborted, true)
        assert.equal(settled, false)
    })

    it('permintaan sesudah leave() memakai pelingkup baru dan tidak ikut batal', async () => {
        const calls = []
        const pageScope = createPageScope()
        const adapter = createApiAdapter(abortable(calls), { pageScope })

        pageScope.leave()
        adapter(get('/activity-logs')).catch(() => {})
        assert.equal(calls[0].signal.aborted, false)
    })

    it('GET milik store/layout (di luar daftar) tidak pernah dibatalkan', async () => {
        const { base, calls } = fakeBase()
        const pageScope = createPageScope()
        const adapter = createApiAdapter(base, { pageScope })

        await adapter(get('/live/sessions'))
        assert.equal(calls[0].signal, undefined)
    })

    it('daftar GET yang dibatalkan hanya endpoint milik view', () => {
        assert.equal(isPageScoped('/live/recordings'), true)
        assert.equal(isPageScoped('/devices/12'), true)
        assert.equal(isPageScoped('/devices/12/commands'), true)
        assert.equal(isPageScoped('/live/sessions'), false)
        assert.equal(isPageScoped('/chat/groups'), false)
        assert.equal(isPageScoped('/auth/me'), false)
    })
})

describe('ttlFor', () => {
    it('acuan lebih lama dari daftar, dan yang tidak dikenal 0', () => {
        assert.ok(ttlFor('/organizations/mine') > ttlFor('/devices'))
        assert.ok(ttlFor('/devices') > ttlFor('/live/overview'))
        assert.equal(ttlFor('/auth/me'), 0)
        assert.equal(ttlFor('/staff-locations'), 0)
        assert.equal(ttlFor('/settings/security'), 0)
    })
})
