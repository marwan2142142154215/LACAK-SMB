import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canEnter } from './pageAccess.js'

const user = (permissions, roles = ['leader']) => ({ roles, permissions, site_scope: 'granted' })
const RADAR = { permissionAll: ['devices.view', 'radar.view'] }

describe('canEnter: halaman Radar', () => {
    it('butuh Lihat device DAN Lihat radar & lokasi', () => {
        assert.equal(canEnter(RADAR, user(['devices.view', 'radar.view'])), true)
        assert.equal(canEnter(RADAR, user(['devices.view'])), false)
        assert.equal(canEnter(RADAR, user(['radar.view'])), false)
        assert.equal(canEnter(RADAR, user([])), false)
        assert.equal(canEnter(RADAR, null), false)
    })
})

describe('canEnter: aturan lain tidak berubah', () => {
    it('permission = salah satu cukup', () => {
        const meta = { permission: ['live.watch', 'live.broadcast'] }
        assert.equal(canEnter(meta, user(['live.broadcast'])), true)
        assert.equal(canEnter(meta, user(['devices.view'])), false)
    })

    it('tanpa syarat = terbuka; super admin saja; peran tertentu', () => {
        assert.equal(canEnter({}, user([])), true)
        assert.equal(canEnter(undefined, null), true)
        assert.equal(canEnter({ requiresSuperAdmin: true }, user([])), false)
        assert.equal(canEnter({ requiresSuperAdmin: true }, user([], ['super_admin'])), true)
        assert.equal(canEnter({ roles: ['admin'] }, user([], ['leader'])), false)
    })
})
