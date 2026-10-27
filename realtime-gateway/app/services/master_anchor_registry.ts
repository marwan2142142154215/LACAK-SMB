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
    isSuperAdmin: boolean
    /** Site yang diberikan ke admin/leader (user_site_access). */
    grantedOrganizationIds: number[]
    socketId: string
}

/** Peran yang aksesnya lewat site yang diberikan, bukan site miliknya sendiri. */
const GRANT_BASED_ROLES = ['admin', 'leader']

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
    },
    socketId: string
) {
    // Cuma akun yang memang boleh lock/unlock yang berhak jadi anchor --
    // staf tanpa izin devices.unlock hadir secara fisik TIDAK boleh ikut
    // membuka kunci device, sama seperti backend menolak perintah Unlock-nya.
    if (!user.permissions.includes('devices.unlock')) return

    // Admin & leader hanya untuk site yang diberikan -- sama dengan
    // authorizedOrganizationId di backend, site "milik" akunnya tidak dihitung.
    const grantBased = user.roles.some((role) => GRANT_BASED_ROLES.includes(role))
    activeBeacons.set(beaconUuid, {
        userId: user.id,
        username: user.username,
        organizationId: grantBased ? null : user.organizationId,
        isSuperAdmin: user.roles.includes('super_admin'),
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
