import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Cocokkan rahasia device dari handshake dengan devices.secret_hash
 * (SHA-256 hex, diisi backend-api DeviceEnrollmentController::claim).
 * Dibandingkan dalam bentuk digest biner dengan timingSafeEqual supaya waktu
 * respons tidak membocorkan berapa byte awal yang sudah cocok.
 */
export function isDeviceSecretValid(plainSecret: string, storedSecretHash: string): boolean {
    const presentedDigest = createHash('sha256').update(plainSecret, 'utf8').digest()
    const storedDigest = Buffer.from(storedSecretHash, 'hex')

    if (storedDigest.length !== presentedDigest.length) {
        return false
    }

    return timingSafeEqual(presentedDigest, storedDigest)
}

/**
 * UUID beacon BLE yang dipancarkan device = 16 byte pertama
 * SHA-256("beacon:" + device_uuid). device_uuid adalah identitas login ke
 * gateway, jadi tidak boleh dipancarkan apa adanya ke siapa pun di sekitar.
 * Turunannya boleh publik karena login sekarang juga butuh rahasia device.
 * WAJIB sama persis dengan BeaconUuid.kt di android-tracked-app dan
 * android-master-app.
 */
export function beaconUuidFor(deviceUuid: string): string {
    const hex = createHash('sha256')
        .update(`beacon:${deviceUuid.trim().toLowerCase()}`, 'utf8')
        .digest('hex')
        .slice(0, 32)

    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
    ].join('-')
}
