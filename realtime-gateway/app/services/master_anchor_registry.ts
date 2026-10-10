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
  socketId: string
}

const activeBeacons = new Map<string, MasterBeacon>()

export function registerMasterBeacon(
  beaconUuid: string,
  user: { id: number; username: string; organizationId: number | null; roles: string[]; permissions: string[] },
  socketId: string
) {
  // Cuma akun yang memang boleh lock/unlock yang berhak jadi anchor --
  // staf view-only (admin/leader/staff_viewer) hadir secara fisik TIDAK
  // boleh ikut membuka kunci device, sama seperti mereka tidak punya tombol
  // Unlock di dashboard/APK master.
  if (!user.permissions.includes('devices.unlock')) return

  activeBeacons.set(beaconUuid, {
    userId: user.id,
    username: user.username,
    organizationId: user.organizationId,
    isSuperAdmin: user.roles.includes('super_admin'),
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
 * MANA PUN (konsisten dengan ResolvesOrganizationScope di backend-api),
 * role lain cuma untuk organization_id miliknya sendiri.
 */
export function isAuthorizedMasterBeaconFor(beaconUuid: string, organizationId: number): boolean {
  const beacon = activeBeacons.get(beaconUuid)
  if (!beacon) return false
  return beacon.isSuperAdmin || beacon.organizationId === organizationId
}
