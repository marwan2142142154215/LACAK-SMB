import { siteScopeOfAccess, type Access } from '#services/Access'

/**
 * Site yang dikelola user untuk shift, absensi, izin/cuti, pengumuman, dan
 * peringatan kerja, menurut CAKUPAN SITE perannya (juga peran buatan sendiri): "Semua site" =
 * semua, "site yang diberikan" = user_site_access, "site sendiri" = site-nya. Boleh-tidaknya
 * mengelola tetap ditentukan izin masing-masing (attendance.manage, work-shifts.manage, ...).
 */
export function managedSites(access: Access): number[] | 'all' {
    const scope = siteScopeOfAccess(access)
    if (access.roles.includes('super_admin') || scope === 'all') return 'all'
    if (scope === 'granted') return [...new Set(access.grantedOrganizationIds)]
    return access.organizationId === null ? [] : [access.organizationId]
}

export function managesSite(access: Access, organizationId: number | null): boolean {
    if (organizationId === null) return managedSites(access) === 'all'
    const sites = managedSites(access)
    return sites === 'all' || sites.includes(organizationId)
}
