import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import type User from '#models/user'
import { success } from '#services/api_response'
import { permissionNamesOf, roleNamesOf } from '#services/permissions'

/**
 * Bagian AuthController backend-api yang sudah dipindah. Login, 2FA, dan
 * logout menyusul di Tahap 2 (docs/rencana-migrasi-adonis.md).
 */
export default class AuthController {
    async me({ authUser }: HttpContext) {
        return success('Data user saat ini', await userPayload(authUser!))
    }

    /** Sama seperti me(), tapi route-nya tanpa perpanjangan token (dipakai gateway). */
    async session({ authUser }: HttpContext) {
        return success('Sesi masih berlaku', await userPayload(authUser!))
    }
}

/** Sama dengan AuthController::userPayload() di backend-api. */
export async function userPayload(user: User) {
    const [roles, permissions, siteRows] = await Promise.all([
        roleNamesOf(user.id),
        permissionNamesOf(user.id),
        db.from('user_site_access').where('user_id', user.id).select('organization_id'),
    ])

    return {
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        organization_id: user.organizationId,
        roles,
        permissions,
        accessible_organization_ids: siteRows.map((row) => row.organization_id),
    }
}
