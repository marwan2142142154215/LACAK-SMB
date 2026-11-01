/**
 * Registry in-memory: APK Master yang sedang login & membuka layar jadi
 * "anchor bergerak" -- selama APK Lacak mendeteksi HP Master itu lewat BLE
 * dalam radius aman, geofence_evaluator menganggapnya bukti device di
 * tempat aman (lihat MASTER_ANCHOR_SAFE_RADIUS_METERS), persis fungsi
 * anchor BLE fisik tapi bisa dibawa-bawa.
 *
 * Diisi lewat event Socket.IO 'master:beacon:start' di namespace /ops
 * (sudah terautentikasi lewat verifyBearerToken, lihat registerOpsNamespace
 * di start/socket.ts) -- UUID yang dipakai dibuat sendiri oleh APK Master
 * (acak per instalasi, lihat MasterAnchorService.kt), BUKAN diterbitkan
 * server, karena keabsahannya datang dari SESI SOCKET yang sudah login,
 * bukan dari nilai UUID itu sendiri.
 *
 * SENGAJA in-memory per instance gateway (sama seperti safeReturnStreaks di
 * geofence_evaluator) -- cukup untuk "siapa yang sedang online sekarang",
 * hilang begitu APK Master ditutup/logout/gateway restart, tidak perlu
 * tahan lama.
 */

type MasterBeacon = {
    userId: number
    username: string
    organizationId: number | null
    /** Cakupan semua site (super_admin, atau peran ber-cakupan "Semua site"). */
    isSuperAdmin: boolean
    /** Site yang diberikan ke peran ber-cakupan "granted" (user_site_access). */
    grantedOrganizationIds: number[]
    socketId: string
}

const activeBeacons = new Map<string, MasterBeacon>()

export function registerMasterBeacon(
    beaconUuid: string,
    user: {
        id: number
        username: string
        organizationId: number | null
        roles: string[]
        permissions: string[]
        accessibleOrganizationIds?: number[]
        /** Cakupan site peran (lihat AuthenticatedUser.siteScope). */
        siteScope?: 'all' | 'granted' | 'own'
    },
    socketId: string
) {
    // Cuma akun yang memang boleh lock/unlock yang berhak jadi anchor --
    // staf tanpa izin devices.unlock hadir secara fisik TIDAK boleh ikut
    // membuka kunci device, sama seperti backend menolak perintah Unlock-nya.
    if (!user.permissions.includes('devices.unlock')) return

    // Cakupan site peran, sama dengan authorizedOrganizationId di backend: "granted" hanya untuk
    // site yang diberikan (site "milik" akunnya tidak dihitung). Peran buatan sendiri ikut aturan ini.
    const scope =
        user.siteScope ??
        (user.roles.some((role) => ['admin', 'leader'].includes(role)) ? 'granted' : 'own')
    const grantBased = scope === 'granted'
    activeBeacons.set(beaconUuid, {
        userId: user.id,
        username: user.username,
        organizationId: grantBased ? null : user.organizationId,
        isSuperAdmin: user.roles.includes('super_admin') || scope === 'all',
        grantedOrganizationIds: grantBased ? (user.accessibleOrganizationIds ?? []) : [],
        socketId,
    })
}

export function unregisterMasterBeaconsForSocket(socketId: string) {
    for (const [uuid, beacon] of activeBeacons) {
        if (beacon.socketId === socketId) activeBeacons.delete(uuid)
    }
}

/**
 * true kalau beaconUuid ini sedang aktif DAN pemiliknya berwenang atas
 * organizationId yang diberikan -- super_admin menghitung untuk site
 * MANA PUN (konsisten dengan organization_scope di backend), admin & leader
 * untuk site yang diberikan ke akunnya, role lain cuma untuk organization_id
 * miliknya sendiri.
 */
export function isAuthorizedMasterBeaconFor(beaconUuid: string, organizationId: number): boolean {
    const beacon = activeBeacons.get(beaconUuid)
    if (!beacon) return false
    return (
        beacon.isSuperAdmin ||
        beacon.organizationId === organizationId ||
        beacon.grantedOrganizationIds.includes(organizationId)
    )
}
