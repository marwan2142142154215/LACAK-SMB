import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { permissionNamesOf, roleNamesOf, siteScopeOf, watchRolesOf } from '#services/Permissions'
import { BUILT_IN_SCOPES, widestScope, type SiteScope } from '#services/RoleRules'

/**
 * Peran, izin, dan akses site user yang sedang login -- dimuat sekali per
 * request (padanan $user->can(), hasRole(), siteAccess() di backend-api).
 */
export type Access = {
    userId: number
    organizationId: number | null
    roles: string[]
    permissions: string[]
    /** user_site_access: site yang diberikan ke peran ber-cakupan "granted" (admin/leader/...). */
    grantedOrganizationIds: number[]
    /** Cakupan site terluas dari semua perannya; kosong = turunkan dari nama peran bawaan. */
    siteScope?: SiteScope
    /** Peran penyiar yang boleh ditonton di Live Kerja; null/undefined = semua, [] = tidak ada. */
    watchRoles?: string[] | null
}

/** Cakupan site efektif: dari database kalau ada, kalau tidak dari nama peran bawaan. */
export function siteScopeOfAccess(access: Access): SiteScope {
    return (
        access.siteScope ?? widestScope(access.roles.map((role) => BUILT_IN_SCOPES[role] ?? 'own'))
    )
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
    const [roles, permissions, grants, siteScope, watchRoles] = await Promise.all([
        roleNamesOf(user.id),
        permissionNamesOf(user.id),
        db.from('user_site_access').where('user_id', user.id).select('organization_id'),
        siteScopeOf(user.id),
        watchRolesOf(user.id),
    ])

    return {
        userId: user.id,
        organizationId: user.organizationId,
        roles,
        permissions,
        grantedOrganizationIds: grants.map((row) => Number(row.organization_id)),
        siteScope,
        watchRoles,
    }
}

export const can = (access: Access, permission: string) => access.permissions.includes(permission)
export const hasRole = (access: Access, role: string) => access.roles.includes(role)

/**
 * Tanpa izin live.roster, user hanya melihat dirinya sendiri di Live Kerja, log
 * kerja, dan rekaman -- siaran & status rekan se-site tertutup. Izin ini dipegang
 * peran pengawas bawaan (super_admin/admin/leader/site_admin), bukan staff_viewer.
 */
export const seesOnlySelf = (access: Access) => !access.permissions.includes('live.roster')

/** Boleh menonton siaran penyiar ber-peran ini (hak tonton per peran di menu Peran). */
export const canWatchRole = (access: Access, role: string) =>
    !access.watchRoles || access.watchRoles.includes(role)

/** Boleh menonton Ruang pusat (siaran user yang tidak terikat site). */
export const canWatchCentral = (access: Access) => access.permissions.includes('live.watch-central')
