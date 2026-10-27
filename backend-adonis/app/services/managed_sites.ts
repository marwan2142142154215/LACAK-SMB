import type { Access } from '#services/access'

/**
 * Site yang dikelola user untuk shift, absensi, izin/cuti, pengumuman, dan
 * peringatan kerja: root semua site; admin & leader site yang diberikan
 * (user_site_access); admin site hanya site-nya sendiri. Staf tidak mengelola.
 */
export function managedSites(access: Access): number[] | 'all' {
    if (access.roles.includes('super_admin')) return 'all'
    const sites = new Set<number>()
    if (access.roles.includes('admin') || access.roles.includes('leader')) {
        access.grantedOrganizationIds.forEach((id) => sites.add(id))
    }
    if (access.roles.includes('site_admin') && access.organizationId !== null) {
        sites.add(access.organizationId)
    }
    return [...sites]
}

export function isManager(access: Access): boolean {
    const sites = managedSites(access)
    return sites === 'all' || sites.length > 0
}

export function managesSite(access: Access, organizationId: number | null): boolean {
    if (organizationId === null) return access.roles.includes('super_admin')
    const sites = managedSites(access)
    return sites === 'all' || sites.includes(organizationId)
}
