import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canReloadNow, entryScriptOf, isChunkLoadError, reloadAllowed } from './appVersion.js'

const BUILT_HTML = `<!doctype html><html><head>
<script>;(function(){var theme='light'})()</script>
<link rel="stylesheet" crossorigin href="/assets/index-Dx3.css">
<script type="module" crossorigin src="/assets/index-AbC123.js"></script>
</head><body><div id="app"></div></body></html>`

describe('entryScriptOf', () => {
    it('mengambil berkas JS utama dari hasil build Vite', () => {
        assert.equal(entryScriptOf(BUILT_HTML), '/assets/index-AbC123.js')
    })

    it('mengabaikan skrip biasa tanpa type="module"', () => {
        assert.equal(entryScriptOf('<script>var a = 1</script>'), null)
    })

    it('mode pengembangan: /src/main.js', () => {
        assert.equal(entryScriptOf('<script type="module" src="/src/main.js"></script>'), '/src/main.js')
    })

    it('teks kosong / bukan teks = null', () => {
        assert.equal(entryScriptOf(''), null)
        assert.equal(entryScriptOf(undefined), null)
    })

    it('dua build berbeda menghasilkan alamat berbeda', () => {
        const next = BUILT_HTML.replace('index-AbC123', 'index-ZzZ999')
        assert.notEqual(entryScriptOf(BUILT_HTML), entryScriptOf(next))
    })
})

describe('isChunkLoadError', () => {
    it('mengenali pesan Chrome, Firefox, dan Safari', () => {
        assert.equal(isChunkLoadError(new Error('Failed to fetch dynamically imported module: https://x/assets/a.js')), true)
        assert.equal(isChunkLoadError(new Error('error loading dynamically imported module: https://x/a.js')), true)
        assert.equal(isChunkLoadError(new Error('Importing a module script failed.')), true)
    })

    it('error lain bukan kegagalan berkas halaman', () => {
        assert.equal(isChunkLoadError(new Error('Network Error')), false)
        assert.equal(isChunkLoadError(null), false)
    })
})

describe('canReloadNow', () => {
    const base = { busy: false, hidden: false, idleMs: 0, minIdleMs: 180_000 }

    it('tidak pernah saat sibuk, walau tab tersembunyi dan lama diam', () => {
        assert.equal(canReloadNow({ ...base, busy: true, hidden: true, idleMs: 999_999 }), false)
    })

    it('tab tersembunyi boleh', () => {
        assert.equal(canReloadNow({ ...base, hidden: true }), true)
    })

    it('tab terlihat hanya setelah diam cukup lama', () => {
        assert.equal(canReloadNow({ ...base, idleMs: 60_000 }), false)
        assert.equal(canReloadNow({ ...base, idleMs: 180_000 }), true)
    })
})

describe('reloadAllowed', () => {
    it('boleh kalau belum pernah atau jedanya cukup', () => {
        assert.equal(reloadAllowed({ lastReloadAt: 0, now: 1_000, minGapMs: 600_000 }), true)
        assert.equal(reloadAllowed({ lastReloadAt: 1_000, now: 700_000, minGapMs: 600_000 }), true)
    })

    it('menolak kalau baru saja memuat ulang (mencegah putaran tanpa henti)', () => {
        assert.equal(reloadAllowed({ lastReloadAt: 1_000, now: 100_000, minGapMs: 600_000 }), false)
    })
})
