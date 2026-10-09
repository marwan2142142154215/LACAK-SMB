import axios from 'axios'
import env from '#start/env'
import log from '#services/log'
import { describeHttpError } from '#services/http_error'

export type AuthenticatedUser = {
    id: number
    username: string
    organizationId: number | null
    roles: string[]
    permissions: string[]
}

type AuthMeResponse = {
    success: boolean
    data?: {
        id: number
        username: string
        organization_id: number | null
        roles: string[]
        permissions: string[]
    }
}

/**
 * Gateway tidak menyimpan/memvalidasi password atau sesi sendiri — token
 * Bearer yang dipakai dashboard/APK master divalidasi dengan menanyakan
 * balik ke backend-api Laravel (satu-satunya sumber kebenaran auth, sesuai
 * instruksi: semua wajib login lewat jalur yang sama).
 */
export async function verifyBearerToken(token: string): Promise<AuthenticatedUser | null> {
    try {
        const response = await axios.get<AuthMeResponse>(
            `${env.get('BACKEND_API_URL')}/api/v1/auth/me`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                },
                // Status non-2xx (mis. 401 token kedaluwarsa) adalah jawaban
                // normal "token tidak sah", bukan kegagalan yang perlu dicatat.
                validateStatus: () => true,
            }
        )

        if (response.status < 200 || response.status >= 300) return null

        const body = response.data
        if (!body.success || !body.data) return null

        return {
            id: body.data.id,
            username: body.data.username,
            organizationId: body.data.organization_id,
            roles: body.data.roles,
            permissions: body.data.permissions,
        }
    } catch (error) {
        log.error('gagal memverifikasi token ke backend-api', describeHttpError(error))
        return null
    }
}
