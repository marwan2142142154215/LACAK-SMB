import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { permissionNamesOf, roleNamesOf } from '#services/permissions'

/**
 * Peran, izin, dan akses site user yang sedang login -- dimuat sekali per
 * request (padanan $user->can(), hasRole(), siteAccess() di backend-api).
 */
export type Access = {
    userId: number
    organizationId: number | null
    roles: string[]
    permissions: string[]
    /** user_site_access: site yang diberikan ke admin/leader. */
    grantedOrganizationIds: number[]
}

const cache = new WeakMap<HttpContext, Promise<Access>>()

export function accessOf(ctx: HttpContext): Promise<Access> {
    let access = cache.get(ctx)
    if (!access) {
        access = load(ctx)
        cache.set(ctx, access)
    }
    return access
}

async function load(ctx: HttpContext): Promise<Access> {
    const user = ctx.authUser!
    const [roles, permissions, grants] = await Promise.all([
        roleNamesOf(user.id),
        permissionNamesOf(user.id),
        db.from('user_site_access').where('user_id', user.id).select('organization_id'),
    ])

    return {
        userId: user.id,
        organizationId: user.organizationId,
        roles,
        permissions,
        grantedOrganizationIds: grants.map((row) => Number(row.organization_id)),
    }
}

export const can = (access: Access, permission: string) => access.permissions.includes(permission)
export const hasRole = (access: Access, role: string) => access.roles.includes(role)
