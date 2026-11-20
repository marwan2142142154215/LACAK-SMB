import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import {
    levelOf,
    permissionNamesOf,
    roleNamesOf,
    siteScopeOf,
    watchRolesOf,
} from '#services/Permissions'
import { BUILT_IN_SCOPES, LEVEL_LOWEST, widestScope, type SiteScope } from '#services/RoleRules'

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
    /**
     * Peran penyiar yang boleh ditonton di Live Kerja (sudah memperhitungkan level); null/undefined
     * = semua, [] = tidak ada.
     */
    watchRoles?: string[] | null
    /** Level tertinggi dari semua perannya (0 = root ... 100); kosong = paling bawah. */
    level?: number
}

/** Level efektif: kosong = paling bawah (hanya melihat dirinya sendiri). */
export const levelOfAccess = (access: Access): number => access.level ?? LEVEL_LOWEST

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

/** Bagian Access yang berasal dari database (selain data user yang sudah dimuat middleware auth). */
type DerivedAccess = Omit<Access, 'userId' | 'organizationId'>

/**
 * Peran/izin/akses site satu user diambil dengan sekitar sepuluh query. Dashboard memanggil API puluhan
 * kali per menit per user, jadi hasilnya disimpan sebentar di memori per user. Perubahan lewat API
 * membuang cache (lihat AuthMiddleware); perubahan dari luar API (command, proses lain) berlaku paling
 * lambat setelah TTL. Saat uji TTL = 0 supaya tes yang mengubah peran melihat hasilnya langsung.
 */
const ACCESS_TTL_MS = app.inTest ? 0 : 10_000
const derivedCache = new Map<number, { at: number; derived: Promise<DerivedAccess> }>()

export function clearAccessCache(): void {
    derivedCache.clear()
}

async function queryDerivedAccess(userId: number): Promise<DerivedAccess> {
    const [roles, permissions, grants, siteScope, watchRoles, level] = await Promise.all([
        roleNamesOf(userId),
        permissionNamesOf(userId),
        db.from('user_site_access').where('user_id', userId).select('organization_id'),
        siteScopeOf(userId),
        watchRolesOf(userId),
        levelOf(userId),
    ])
    return {
        roles,
        permissions,
        grantedOrganizationIds: grants.map((row) => Number(row.organization_id)),
        siteScope,
        watchRoles,
        level,
    }
}

function derivedAccessOf(userId: number): Promise<DerivedAccess> {
    if (ACCESS_TTL_MS === 0) return queryDerivedAccess(userId)

    const cached = derivedCache.get(userId)
    if (cached && Date.now() - cached.at < ACCESS_TTL_MS) return cached.derived

    const derived = queryDerivedAccess(userId)
    derivedCache.set(userId, { at: Date.now(), derived })
    // Gagal tidak boleh tersimpan: request berikutnya mencoba lagi.
    derived.catch(() => {
        if (derivedCache.get(userId)?.derived === derived) derivedCache.delete(userId)
    })
    return derived
}

async function load(ctx: HttpContext): Promise<Access> {
    const user = ctx.authUser!
    const derived = await derivedAccessOf(user.id)

    // Salinan per request: pemanggil boleh mengubah array-nya tanpa mempengaruhi request lain.
    return {
        userId: user.id,
        organizationId: user.organizationId,
        roles: [...derived.roles],
        permissions: [...derived.permissions],
        grantedOrganizationIds: [...derived.grantedOrganizationIds],
        siteScope: derived.siteScope,
        watchRoles: derived.watchRoles ? [...derived.watchRoles] : derived.watchRoles,
        level: derived.level,
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
