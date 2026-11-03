import type { AuthenticatedUser } from '#services/BackendApiClient'

/**
 * Lokasi device (koordinat, jarak BLE) lewat socket hanya untuk pemegang izin radar.view -- halaman
 * Radar juga butuh devices.view. Event radar:update dikirim ke ruang radar khusus ini, BUKAN ke
 * ruang site (`org:{id}`) yang juga dipakai device:status & violation:alert untuk halaman Device.
 */
export const RADAR_ALL_ROOM = 'radar:all'
export const RADAR_ROOM_PREFIX = 'radar:'

export const radarOrganizationRoom = (organizationId: number) => `radar:org:${organizationId}`

export function canSeeRadar(user: AuthenticatedUser): boolean {
    return user.permissions.includes('radar.view') && user.permissions.includes('devices.view')
}

/** Ruang radar yang boleh diikuti user ini menurut cakupan site perannya; kosong = tanpa izin. */
export function radarRoomsFor(user: AuthenticatedUser): string[] {
    if (!canSeeRadar(user)) return []
    if (user.roles.includes('super_admin') || user.siteScope === 'all') return [RADAR_ALL_ROOM]

    const sites =
        user.siteScope === 'granted'
            ? user.accessibleOrganizationIds
            : user.organizationId
              ? [user.organizationId]
              : []
    return sites.map(radarOrganizationRoom)
}
