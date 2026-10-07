import env from '#start/env'

export type AuthenticatedUser = {
  id: number
  username: string
  organizationId: number | null
  roles: string[]
  permissions: string[]
}

/**
 * Gateway tidak menyimpan/memvalidasi password atau sesi sendiri — token
 * Bearer yang dipakai dashboard/APK master divalidasi dengan menanyakan
 * balik ke backend-api Laravel (satu-satunya sumber kebenaran auth, sesuai
 * instruksi: semua wajib login lewat jalur yang sama).
 */
export async function verifyBearerToken(token: string): Promise<AuthenticatedUser | null> {
  try {
    const response = await fetch(`${env.get('BACKEND_API_URL')}/api/v1/auth/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    })

    if (!response.ok) return null

    const body = (await response.json()) as {
      success: boolean
      data?: {
        id: number
        username: string
        organization_id: number | null
        roles: string[]
        permissions: string[]
      }
    }

    if (!body.success || !body.data) return null

    return {
      id: body.data.id,
      username: body.data.username,
      organizationId: body.data.organization_id,
      roles: body.data.roles,
      permissions: body.data.permissions,
    }
  } catch {
    return null
  }
}
