import { hasRole, type Access } from '#services/access'

/**
 * Padanan trait ResolvesOrganizationScope di backend-api: site mana yang
 * boleh dilihat user. super_admin lintas site; admin/leader hanya site yang
 * diberikan (user_site_access); peran lain hanya site miliknya sendiri.
 *
 * Akun layanan bot Telegram (telegram_bot_service) belum didukung di sini --
 * bot tidak dipakai, dan endpointnya tetap dilayani backend-api.
 */
export function hasCrossOrganizationAccess(access: Access): boolean {
    return hasRole(access, 'super_admin')
}

export function hasGrantBasedAccess(access: Access): boolean {
    return hasRole(access, 'admin') || hasRole(access, 'leader')
}

/**
 * Site yang boleh dipakai untuk permintaan ini, atau null kalau ditolak.
 * Admin/leader WAJIB menyebut site; staf tanpa site diminta = site sendiri.
 */
export function authorizedOrganizationId(access: Access, requested: number | null): number | null {
    if (hasCrossOrganizationAccess(access)) {
        return requested
    }
    if (hasGrantBasedAccess(access)) {
        return requested !== null && access.grantedOrganizationIds.includes(requested)
            ? requested
            : null
    }
    if (requested !== null && requested !== access.organizationId) {
        return null
    }
    return access.organizationId
}

/**
 * Filter organization_id untuk query daftar: 'all' (super_admin), daftar id,
 * atau null kalau tidak ada yang boleh dilihat. Padanan scopeToOrganization().
 */
export function organizationFilter(
    access: Access,
    requested: number | null = null
): 'all' | number[] | null {
    if (hasCrossOrganizationAccess(access)) {
        return requested ? [requested] : 'all'
    }
    if (hasGrantBasedAccess(access)) {
        if (requested !== null) {
            return access.grantedOrganizationIds.includes(requested) ? [requested] : null
        }
        return access.grantedOrganizationIds
    }
    if (requested !== null && requested !== access.organizationId) {
        return null
    }
    return access.organizationId === null ? [] : [access.organizationId]
}
