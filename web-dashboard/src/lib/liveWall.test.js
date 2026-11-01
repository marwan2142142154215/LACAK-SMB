import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildWallMembers, pageCountOf, pageSlice, roomKeyOfMember, wantedRoomKeys } from './liveWall.js'
import { parseRoomKey, roomKey } from './roomKey.js'

const member = (id, name, overrides = {}) => ({
    user_id: id,
    name,
    organization_id: 1,
    live_role: 'staff_viewer',
    participant_identity: `user-${id}`,
    status: 'working',
    started_at: '2026-11-01T05:00:00Z',
    ...overrides,
})

const everyone = () => true
const noTransport = () => null
const noGroup = () => null

const build = (roster, options = {}) =>
    buildWallMembers(roster, { matches: everyone, transportOf: noTransport, labelOf: noGroup, ...options })

describe('roomKey', () => {
    it('membentuk dan membaca kunci room site & Ruang pusat', () => {
        assert.equal(roomKey(3, 'staff_viewer'), '3:staff_viewer')
        assert.equal(roomKey(null, 'leader'), 'pusat:leader')
        assert.deepEqual(parseRoomKey('3:staff_viewer'), { organizationId: 3, role: 'staff_viewer' })
        assert.deepEqual(parseRoomKey('pusat:leader'), { organizationId: null, role: 'leader' })
    })

    it('menolak kunci yang bukan room', () => {
        for (const bad of [null, undefined, 'all', '3', '3:', ':role', '3:Role', '../x:role']) assert.equal(parseRoomKey(bad), null)
    })

    it('peran kosong jatuh ke "lainnya"', () => {
        assert.equal(roomKey(2, null), '2:lainnya')
    })
})

describe('buildWallMembers', () => {
    it('hanya staf yang sudah mulai kerja', () => {
        const roster = [member(1, 'Ani'), member(2, 'Budi', { started_at: null, status: 'offline' })]
        assert.deepEqual(build(roster).map((m) => m.user_id), [1])
    })

    it('urut nama, tidak terpengaruh urutan masuk', () => {
        const roster = [member(3, 'Citra'), member(1, 'Ani'), member(2, 'Budi')]
        assert.deepEqual(build(roster).map((m) => m.name), ['Ani', 'Budi', 'Citra'])
    })

    it('urut kelompok dulu, lalu nama di dalam kelompok', () => {
        const roster = [member(1, 'Zaki', { organization_id: 1 }), member(2, 'Ani', { organization_id: 2 }), member(3, 'Budi', { organization_id: 1 })]
        const labels = { 1: 'Alfa', 2: 'Beta' }
        const result = build(roster, { labelOf: (m) => labels[m.organization_id] })
        assert.deepEqual(result.map((m) => m.name), ['Budi', 'Zaki', 'Ani'])
    })

    it('menyaring status & pencarian nama', () => {
        const roster = [member(1, 'Ani', { status: 'idle' }), member(2, 'Anto', { status: 'working' }), member(3, 'Budi', { status: 'working' })]
        const matches = (name) => name.toLowerCase().includes('an')
        assert.deepEqual(build(roster, { statusFilter: 'working', matches }).map((m) => m.name), ['Anto'])
    })

    it('saringan jalur memakai jalur identity staf', () => {
        const roster = [member(1, 'Ani'), member(2, 'Budi')]
        const transportOf = (identity) => (identity === 'user-2' ? 'tcp' : 'udp')
        assert.deepEqual(build(roster, { transportFilter: 'tcp', transportOf }).map((m) => m.name), ['Budi'])
    })

    it('tidak mengubah daftar asal', () => {
        const roster = [member(2, 'Budi'), member(1, 'Ani')]
        build(roster)
        assert.deepEqual(roster.map((m) => m.name), ['Budi', 'Ani'])
    })
})

describe('halaman', () => {
    const members = Array.from({ length: 30 }, (_, index) => member(index + 1, `Staf ${String(index + 1).padStart(2, '0')}`))

    it('menghitung jumlah halaman (minimal 1)', () => {
        assert.equal(pageCountOf(0, 12), 1)
        assert.equal(pageCountOf(12, 12), 1)
        assert.equal(pageCountOf(13, 12), 2)
        assert.equal(pageCountOf(30, 12), 3)
    })

    it('mengambil tepat satu halaman', () => {
        assert.equal(pageSlice(members, 0, 12).length, 12)
        assert.equal(pageSlice(members, 2, 12).length, 6)
        assert.deepEqual(pageSlice(members, 1, 12).map((m) => m.user_id).slice(0, 2), [13, 14])
        assert.deepEqual(pageSlice(members, 5, 12), [])
    })
})

describe('wantedRoomKeys', () => {
    it('hanya room staf di halaman yang tampil, tanpa duplikat', () => {
        const visible = [member(1, 'A', { organization_id: 1 }), member(2, 'B', { organization_id: 1 }), member(3, 'C', { organization_id: 2 })]
        assert.deepEqual(wantedRoomKeys({ visibleMembers: visible }), ['1:staff_viewer', '2:staff_viewer'])
    })

    it('halaman lain tidak ikut: staf di luar halaman tidak membuka room', () => {
        const all = [member(1, 'A', { organization_id: 1 }), member(2, 'B', { organization_id: 9 })]
        const visible = pageSlice(all, 0, 1)
        assert.deepEqual(wantedRoomKeys({ visibleMembers: visible }), ['1:staff_viewer'])
    })

    it('Ruang pusat yang live selalu ikut, yang belum mulai kerja tidak', () => {
        const central = [member(10, 'P', { organization_id: null, live_role: 'leader' }), member(11, 'Q', { organization_id: null, live_role: 'admin', started_at: null })]
        assert.deepEqual(wantedRoomKeys({ visibleMembers: [], centralMembers: central }), ['pusat:leader'])
    })

    it('staf yang sedang diperbesar membuka room-nya walau di halaman lain', () => {
        const focused = member(5, 'F', { organization_id: 7, live_role: 'leader' })
        assert.deepEqual(wantedRoomKeys({ visibleMembers: [], focusedMember: focused }), ['7:leader'])
    })

    it('staf diperbesar yang sudah berhenti tidak membuka room', () => {
        const focused = member(5, 'F', { started_at: null })
        assert.deepEqual(wantedRoomKeys({ visibleMembers: [], focusedMember: focused }), [])
    })

    it('saringan jalur membuka semua room yang live menggantikan halaman', () => {
        const visible = [member(1, 'A', { organization_id: 1 })]
        const result = wantedRoomKeys({ visibleMembers: visible, allRoomKeys: ['2:leader', '3:staff_viewer'] })
        assert.deepEqual(result, ['2:leader', '3:staff_viewer'])
    })

    it('kunci room anggota sama dengan roomKey()', () => {
        assert.equal(roomKeyOfMember(member(1, 'A', { organization_id: 4, live_role: 'leader' })), roomKey(4, 'leader'))
    })

    it('maksimal 12 room untuk satu halaman 12 staf', () => {
        const all = Array.from({ length: 40 }, (_, index) => member(index + 1, `S${index}`, { organization_id: index + 1 }))
        assert.equal(wantedRoomKeys({ visibleMembers: pageSlice(all, 0, 12) }).length, 12)
    })
})
