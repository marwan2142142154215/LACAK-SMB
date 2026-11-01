import log from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { Access } from '#services/Access'
import { issue, liveKitConfig } from '#services/Livekit'
import { managedSites } from '#services/ManagedSites'

/**
 * Briefing: rapat video Live dalam satu ruang (room LiveKit briefing-{id}).
 * Pemimpin memilih peran & site yang boleh bergabung; aturan di sini dipakai
 * controller saat membuat, mendaftar, dan memberi token bergabung.
 */

/** Label singkat peran bawaan untuk dashboard; peran lain memakai roles.label. */
export const BRIEFING_AUDIENCE_ROLES = {
    staff_viewer: 'Staf',
    leader: 'Leader',
    site_admin: 'Admin site',
    admin: 'Admin',
    super_admin: 'Root',
} as const

export type BriefingRow = {
    id: number
    title: string
    host_user_id: number
    allowed_roles: string[]
    /** Kosong = semua site. */
    allowed_organization_ids: number[]
    /** Peserta pilihan pemimpin; kosong = undangan menurut peran & site. */
    invited_user_ids: number[]
    started_at: Date
    ended_at: Date | null
    /** Dibuka otomatis dari jadwal (briefing_schedules). */
    schedule_id?: number | null
    planned_end_at?: Date | null
}

export const roomForBriefing = (briefingId: number) => `briefing-${briefingId}`

/** Pola kode peran (sama dengan RoleRules.ROLE_NAME_PATTERN), untuk validasi isian undangan. */
export const AUDIENCE_ROLE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/

const audienceLabel = (name: string, label: string | null) =>
    BRIEFING_AUDIENCE_ROLES[name as keyof typeof BRIEFING_AUDIENCE_ROLES] ?? label ?? name

/**
 * Peran yang bisa diundang ke briefing / dituju pengumuman: SEMUA peran, termasuk buatan sendiri
 * (mis. auditor), kecuali akun layanan bot. Dulu hanya 5 peran bawaan, jadi user ber-peran buatan
 * sendiri diam-diam tidak pernah melihat briefing/pengumuman yang menyebut peran.
 */
export async function audienceRoles(): Promise<Array<{ value: string; label: string }>> {
    const rows = await db
        .from('roles')
        .where('guard_name', 'web')
        .whereNot('name', 'telegram_bot_service')
        .orderBy('id')
        .select('name', 'label')
    return rows.map((row) => ({ value: row.name, label: audienceLabel(row.name, row.label) }))
}

/** Peran di daftar ini yang tidak ada (untuk menolak isian yang tidak sah). */
export async function unknownAudienceRoles(roles: string[]): Promise<string[]> {
    if (!roles.length) return []
    const options = await audienceRoles()
    const known = new Set(options.map((role) => role.value))
    return roles.filter((role) => !known.has(role))
}

/** Boleh membuat & memimpin briefing (izin briefing.host; dulu dikunci ke peran). */
export function canHostBriefing(access: Access): boolean {
    return access.permissions.includes('briefing.host')
}

/**
 * Site yang "dimiliki" user untuk keperluan undangan briefing: mengikuti cakupan site perannya
 * (juga peran buatan sendiri, mis. auditor "Semua site"), sama dengan managedSites.
 */
export function sitesOf(access: Access): number[] | 'all' {
    return managedSites(access)
}

/**
 * Boleh bergabung? Pemimpin & root selalu boleh. Briefing dengan peserta
 * pilihan: hanya user yang diundang. Selain itu peran user harus ada di
 * daftar undangan DAN salah satu site-nya termasuk site yang diundang
 * (daftar site kosong = semua site).
 */
export function canJoinBriefing(access: Access, briefing: BriefingRow): boolean {
    if (briefing.ended_at) return false
    if (briefing.host_user_id === access.userId || access.roles.includes('super_admin')) return true
    if (briefing.invited_user_ids?.length) return briefing.invited_user_ids.includes(access.userId)
    if (!access.roles.some((role) => briefing.allowed_roles.includes(role))) return false
    if (!briefing.allowed_organization_ids.length) return true
    const sites = sitesOf(access)
    if (sites === 'all') return true
    return sites.some((id) => briefing.allowed_organization_ids.includes(id))
}

/**
 * Token bergabung: kamera, mikrofon, dan berbagi layar untuk semua peserta.
 */
export function briefingToken(briefing: BriefingRow, user: { id: number; name: string }): string {
    return issue(`user-${user.id}`, user.name, {
        room: roomForBriefing(briefing.id),
        roomJoin: true,
        canPublish: true,
        // Semua peserta boleh presentasi layar, bukan hanya pemimpin.
        canPublishSources: ['camera', 'microphone', 'screen_share'],
        canSubscribe: true,
        canPublishData: false,
        canUpdateOwnMetadata: false,
    })
}

/** Briefing diakhiri: semua peserta dikeluarkan dari room. Best-effort. */
export async function closeBriefingRoom(briefingId: number) {
    const config = liveKitConfig()
    const room = roomForBriefing(briefingId)
    const httpUrl = config.url.replace(/\/+$/, '').replace(/^ws(s?):\/\//, 'http$1://')
    try {
        const response = await fetch(`${httpUrl}/twirp/livekit.RoomService/DeleteRoom`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${issue('backend-api', 'backend-api', { roomCreate: true }, config)}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ room }),
            signal: AbortSignal.timeout(5000),
        })
        if (!response.ok && response.status !== 404) {
            log.warn({ room, status: response.status }, 'Gagal menutup room briefing')
        }
    } catch (error) {
        log.warn({ room, err: error }, 'Gagal menghubungi LiveKit untuk menutup room briefing')
    }
}
