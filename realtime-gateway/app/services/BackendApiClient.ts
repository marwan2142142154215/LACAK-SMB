import axios from 'axios'
import env from '#start/env'
import log from '#services/Log'
import { describeHttpError } from '#services/HttpError'
import { userHeaders } from '#services/ClientIp'

export type AuthenticatedUser = {
    id: number
    username: string
    name: string
    organizationId: number | null
    roles: string[]
    permissions: string[]
    /** Site yang diberikan ke admin/leader (user_site_access); kosong untuk peran lain. */
    accessibleOrganizationIds: number[]
    /**
     * Cakupan site terluas dari semua perannya (sama dengan backend): all = semua site,
     * granted = accessibleOrganizationIds, own = site sendiri. Peran buatan sendiri ikut aturan ini.
     */
    siteScope: 'all' | 'granted' | 'own'
    /** Peran penyiar yang boleh ditonton di Live Kerja; null = semua peran. */
    watchRoles: string[] | null
}

type AuthMeResponse = {
    success: boolean
    data?: {
        id: number
        username: string
        name: string
        organization_id: number | null
        roles: string[]
        permissions: string[]
        accessible_organization_ids?: number[]
        site_scope?: string
        watch_roles?: string[] | null
    }
}

/**
 * Gateway tidak menyimpan/memvalidasi password atau sesi sendiri — token
 * Bearer yang dipakai dashboard/APK master divalidasi dengan menanyakan
 * balik ke backend-api Laravel (satu-satunya sumber kebenaran auth, sesuai
 * instruksi: semua wajib login lewat jalur yang sama).
 */
/**
 * Cek ulang sesi dashboard lewat /auth/session, yang sengaja tidak memperpanjang
 * idle timeout token. true = masih berlaku, false = ditolak backend (401/403),
 * null = backend tidak bisa dihubungi (jangan perlakukan sebagai sesi habis).
 */
export async function isSessionStillValid(token: string): Promise<boolean | null> {
    return checkSession(token, '/api/v1/auth/session')
}

/**
 * Sama seperti isSessionStillValid(), tapi lewat /auth/me yang MEMPERPANJANG
 * idle timeout token -- untuk staf yang sedang siaran Live Kerja: heartbeat-nya
 * lewat socket, jadi tidak ada request HTTP lain yang menjaga sesinya hidup.
 */
export async function extendSession(token: string): Promise<boolean | null> {
    return checkSession(token, '/api/v1/auth/me')
}

async function checkSession(token: string, path: string): Promise<boolean | null> {
    try {
        const response = await axios.get(`${env.get('BACKEND_API_URL')}${path}`, {
            headers: userHeaders(token),
            validateStatus: () => true,
        })

        if (response.status === 401 || response.status === 403) return false
        if (response.status >= 200 && response.status < 300) return true
        return null
    } catch (error) {
        log.error('gagal mengecek ulang sesi ke backend-api', describeHttpError(error))
        return null
    }
}

/**
 * site_scope dari /auth/me. Backend lama tanpa kolom ini: turunkan dari nama peran
 * bawaan seperti dulu (super_admin = all, admin/leader = granted, lainnya = own).
 */
function siteScopeOf(value: string | undefined, roles: string[]): AuthenticatedUser['siteScope'] {
    if (value === 'all' || value === 'granted' || value === 'own') return value
    if (roles.includes('super_admin')) return 'all'
    if (roles.includes('admin') || roles.includes('leader')) return 'granted'
    return 'own'
}

/**
 * Data user dari token. `path` /auth/me memperpanjang sesi (saat connect), /auth/session tidak
 * (dipakai cek ulang berkala untuk memuat ulang izin & hak tonton terbaru).
 */
export async function verifyBearerToken(
    token: string,
    path: '/api/v1/auth/me' | '/api/v1/auth/session' = '/api/v1/auth/me'
): Promise<AuthenticatedUser | null> {
    try {
        const response = await axios.get<AuthMeResponse>(`${env.get('BACKEND_API_URL')}${path}`, {
            headers: userHeaders(token),
            // Status non-2xx (mis. 401 token kedaluwarsa) adalah jawaban
            // normal "token tidak sah", bukan kegagalan yang perlu dicatat.
            validateStatus: () => true,
        })

        if (response.status < 200 || response.status >= 300) return null

        const body = response.data
        if (!body.success || !body.data) return null

        return {
            id: body.data.id,
            username: body.data.username,
            name: body.data.name,
            organizationId: body.data.organization_id,
            roles: body.data.roles,
            permissions: body.data.permissions,
            accessibleOrganizationIds: (body.data.accessible_organization_ids ?? []).map(Number),
            siteScope: siteScopeOf(body.data.site_scope, body.data.roles),
            // Backend lama tanpa kolom ini = semua peran (perilaku sebelum hak tonton per peran).
            watchRoles: Array.isArray(body.data.watch_roles) ? body.data.watch_roles : null,
        }
    } catch (error) {
        log.error('gagal memverifikasi token ke backend-api', describeHttpError(error))
        return null
    }
}
