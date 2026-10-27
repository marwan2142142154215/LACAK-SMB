import log from '@adonisjs/core/services/logger'
import type { Access } from '#services/access'
import { issue, liveKitConfig } from '#services/livekit'

/**
 * Briefing: rapat video Live dalam satu ruang (room LiveKit briefing-{id}).
 * Pemimpin memilih peran & site yang boleh bergabung; aturan di sini dipakai
 * controller saat membuat, mendaftar, dan memberi token bergabung.
 */

/** Peran yang boleh memulai & memimpin briefing. */
export const BRIEFING_HOST_ROLES = ['super_admin', 'admin', 'leader'] as const

/** Peran yang bisa diundang, dengan label untuk dashboard. */
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

export function canHostBriefing(access: Access): boolean {
    return BRIEFING_HOST_ROLES.some((role) => access.roles.includes(role))
}

/** Site yang "dimiliki" user untuk keperluan undangan briefing. */
export function sitesOf(access: Access): number[] | 'all' {
    if (access.roles.includes('super_admin')) return 'all'
    if (access.roles.includes('admin') || access.roles.includes('leader')) {
        return access.grantedOrganizationIds
    }
    return access.organizationId === null ? [] : [access.organizationId]
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
 * Token bergabung: kamera & mikrofon untuk semua peserta, berbagi layar hanya
 * pemimpin (untuk presentasi).
 */
export function briefingToken(
    briefing: BriefingRow,
    user: { id: number; name: string },
    isHost: boolean
): string {
    return issue(`user-${user.id}`, user.name, {
        room: roomForBriefing(briefing.id),
        roomJoin: true,
        canPublish: true,
        canPublishSources: isHost
            ? ['camera', 'microphone', 'screen_share']
            : ['camera', 'microphone'],
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
