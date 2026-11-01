import { roomKey } from './roomKey.js'

// Logika murni dinding Live Kerja (tanpa Vue/LiveKit supaya bisa diuji): dinding dibangun dari DAFTAR staf
// yang live, dan room video hanya dibuka untuk staf di halaman yang tampil.

/**
 * Staf live yang lolos saringan, urut kelompok lalu nama (urutan tetap supaya ubin tidak berpindah sendiri).
 * `matches(name)`: cocok dengan pencarian; `transportOf(identity)`: 'udp' | 'tcp' | null; `labelOf(member)`: judul kelompok.
 */
export function buildWallMembers(roster, { statusFilter = null, transportFilter = null, matches, transportOf, labelOf }) {
    const label = (member) => labelOf(member) ?? ''
    return roster
        .filter(
            (member) =>
                member.started_at &&
                (!statusFilter || member.status === statusFilter) &&
                (!transportFilter || transportOf(member.participant_identity) === transportFilter) &&
                matches(member.name),
        )
        .sort((a, b) => label(a).localeCompare(label(b)) || a.name.localeCompare(b.name))
}

export const pageCountOf = (total, pageSize) => Math.max(1, Math.ceil(total / pageSize))

/** Anggota halaman ke-`page` (mulai 0). */
export const pageSlice = (members, page, pageSize) => members.slice(page * pageSize, (page + 1) * pageSize)

/**
 * Kunci room yang harus terbuka: halaman yang tampil + Ruang pusat + staf yang sedang diperbesar.
 * `allRoomKeys` (bukan null) menggantikan halaman: dipakai saringan UDP/TCP yang butuh semua room.
 */
export function wantedRoomKeys({ visibleMembers, centralMembers = [], focusedMember = null, allRoomKeys = null }) {
    const keys = new Set(allRoomKeys ?? visibleMembers.map(roomKeyOfMember))
    for (const member of centralMembers) if (member.started_at) keys.add(roomKeyOfMember(member))
    if (focusedMember?.started_at) keys.add(roomKeyOfMember(focusedMember))
    return [...keys].sort()
}

export const roomKeyOfMember = (member) => roomKey(member.organization_id, member.live_role)
