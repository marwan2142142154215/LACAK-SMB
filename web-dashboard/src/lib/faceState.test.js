import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFaceState } from './faceState.js'

function setup() {
    let t = 0
    const state = createFaceState({ missingAfterMs: 30_000, unknownAfterMs: 30_000, now: () => t })
    return { state, advance: (ms) => (t += ms) }
}

test('tidak ada wajah 30 detik = hilang, wajah terlihat lagi = kembali', () => {
    const { state, advance } = setup()
    advance(29_000)
    assert.equal(state.notSeen(), false)
    advance(1_000)
    assert.equal(state.notSeen(), true)
    advance(1_000)
    assert.equal(state.seen(), false)
})

test('cek yang gagal terus-menerus tidak menahan status hilang selamanya', () => {
    const { state, advance } = setup()
    advance(30_000)
    assert.equal(state.notSeen(), true)
    // Frame kamera macet / model error: belum 30 detik, status lama dipertahankan.
    advance(10_000)
    assert.equal(state.failed(), true)
    // Gagal >= 30 detik sejak cek terakhir yang berhasil: tidak diketahui = tidak hilang.
    advance(20_000)
    assert.equal(state.failed(), false)
    // Hitungan dimulai lagi: tidak langsung hilang begitu cek berhasil tanpa wajah.
    advance(1_000)
    assert.equal(state.notSeen(), false)
})

test('kamera mati bukan wajah hilang', () => {
    const { state, advance } = setup()
    advance(40_000)
    assert.equal(state.notSeen(), true)
    assert.equal(state.cameraOff(), false)
})
