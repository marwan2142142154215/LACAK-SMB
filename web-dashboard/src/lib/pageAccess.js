/**
 * Boleh membuka halaman dengan meta ini? Satu-satunya aturan akses halaman: dipakai penjaga rute
 * (router) DAN menu sidebar (AppShell), jadi menu yang tampil selalu bisa dibuka dan sebaliknya.
 * `permission` boleh satu izin atau daftar (cukup salah satu); `permissionAll` = SEMUA izin di daftar
 * wajib dipegang (mis. Radar: Lihat device + Lihat radar & lokasi).
 */
export function canEnter(meta, user) {
    const roles = user?.roles ?? []
    const permissions = user?.permissions ?? []
    const isSuperAdmin = roles.includes('super_admin')
    if (meta?.requiresSuperAdmin && !isSuperAdmin) return false
    if (meta?.roles && !meta.roles.some((role) => roles.includes(role))) return false
    if (meta?.staffAccess && !isSuperAdmin && user?.site_scope !== 'granted') return false
    if (meta?.permission && ![meta.permission].flat().some((permission) => permissions.includes(permission))) return false
    if (meta?.permissionAll && !meta.permissionAll.every((permission) => permissions.includes(permission))) return false
    return true
}
