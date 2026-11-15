import QRCode from 'qrcode'

/**
 * QR provisioning Device Owner untuk HP ASET PERUSAHAAN (bukan HP pribadi): HP yang baru di-reset
 * pabrik, di layar sambutan diketuk 6 kali -> pemindai QR terbuka -> QR ini dipindai -> Android
 * mengunduh APK Pelacak dari tautan bertanda tangan, memeriksa checksum-nya, memasangnya sebagai
 * Device Owner, lalu pemegang HP menyetujui layar persetujuan bawaan Android.
 *
 * Sebagai Device Owner APK Pelacak bisa memberi izinnya sendiri (lokasi, Bluetooth, notifikasi),
 * memakai mode kunci penuh (lock task) dan memulai layar kunci dari latar belakang -- jadi staf
 * lapangan tidak perlu melewati langkah izin satu per satu. Notifikasi pemantauan tetap tampil.
 *
 * Referensi kunci extra: android.app.admin.DevicePolicyManager (EXTRA_PROVISIONING_*).
 */

/**
 * APK dari menu Build APK adalah build debug -> applicationId berakhiran ".debug"
 * (android-tracked-app/app/build.gradle.kts, applicationIdSuffix). Kelas receiver tetap di
 * namespace com.lacaksmb.tracker.
 */
export const TRACKER_PACKAGE_NAME = 'com.lacaksmb.tracker.debug'
export const TRACKER_ADMIN_RECEIVER = 'com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver'

/** Tautan unduh di QR berlaku sesingkat mungkin -- APK berisi rahasia device (zero-touch). */
export const PROVISIONING_URL_MINUTES = 120

/** SHA-256 hex -> base64 URL-safe tanpa padding (format EXTRA_PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM). */
export function checksumForProvisioning(sha256Hex: string): string {
    if (!/^[0-9a-f]{64}$/i.test(sha256Hex)) {
        throw new Error('Checksum APK tidak valid untuk provisioning')
    }
    return Buffer.from(sha256Hex, 'hex').toString('base64url')
}

export function provisioningPayload(options: {
    downloadUrl: string
    checksumSha256: string
    packageName?: string
}) {
    const packageName = options.packageName ?? TRACKER_PACKAGE_NAME
    return {
        'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': `${packageName}/${TRACKER_ADMIN_RECEIVER}`,
        'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION':
            options.downloadUrl,
        'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM': checksumForProvisioning(
            options.checksumSha256
        ),
        // HP tetap bisa dipakai bekerja seperti biasa: aplikasi sistem (kamera, telepon, dll.) tidak
        // dinonaktifkan oleh provisioning.
        'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
    }
}

/** QR (SVG) berisi payload JSON -- dipindai dari layar sambutan HP yang baru di-reset pabrik. */
export async function provisioningQrSvg(payload: Record<string, unknown>): Promise<string> {
    return QRCode.toString(JSON.stringify(payload), {
        type: 'svg',
        margin: 2,
        // Tautan bertanda tangan cukup panjang; level M masih terbaca kamera HP murah.
        errorCorrectionLevel: 'M',
    })
}
