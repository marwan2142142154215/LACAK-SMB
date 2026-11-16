package com.lacaksmb.tracker.admin

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.os.Build
import android.os.UserManager
import android.util.Log

/**
 * Penyiapan otomatis untuk HP aset perusahaan yang dipasang sebagai DEVICE OWNER lewat QR
 * provisioning (lihat docs/provisioning-device-owner.md). Device Owner boleh memberi izin runtime
 * app-nya sendiri, jadi staf lapangan tidak perlu menekan dialog izin satu per satu.
 *
 * Yang diberikan HANYA izin yang memang dipakai dan diungkapkan di layar APK: lokasi (termasuk
 * latar belakang), Bluetooth (radar jarak dekat), dan notifikasi (notifikasi pemantauan yang
 * selalu tampil). Tidak ada izin SMS, kontak, log panggilan, kamera, mikrofon, atau penyimpanan.
 * Android 12+ menampilkan pemberitahuan sendiri ke pemegang HP saat admin memberi izin lokasi.
 *
 * Di HP biasa (bukan Device Owner) fungsi ini tidak melakukan apa pun.
 */
object DeviceOwnerSetup {
    private const val TAG = "DeviceOwnerSetup"

    fun applyIfDeviceOwner(context: Context): Boolean {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
            ?: return false
        if (!dpm.isDeviceOwnerApp(context.packageName)) return false

        val admin = TrackerDeviceAdminReceiver.componentName(context)
        // Urutan penting: lokasi latar belakang hanya bisa diberikan setelah lokasi biasa.
        val permissions = buildList {
            add(Manifest.permission.ACCESS_FINE_LOCATION)
            add(Manifest.permission.ACCESS_COARSE_LOCATION)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                add(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                add(Manifest.permission.BLUETOOTH_SCAN)
                add(Manifest.permission.BLUETOOTH_CONNECT)
                add(Manifest.permission.BLUETOOTH_ADVERTISE)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        for (permission in permissions) {
            try {
                dpm.setPermissionGrantState(
                    admin,
                    context.packageName,
                    permission,
                    DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED,
                )
            } catch (e: SecurityException) {
                // Mis. pemegang HP menolak "admin boleh memberi izin sensor" saat provisioning
                // Android 12+ -- izin itu lalu diminta lewat layar panduan seperti HP biasa.
                Log.w(TAG, "izin $permission tidak bisa diberikan otomatis: ${e.message}")
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "izin $permission tidak dikenal di versi Android ini: ${e.message}")
            }
        }
        TrackerDeviceAdminReceiver.enableFullLockTaskIfDeviceOwner(context)
        applyCompanyLockPolicies(dpm, admin, context)
        return true
    }

    /**
     * Kebijakan HP aset perusahaan yang hanya bisa diterapkan Device Owner, sesuai persetujuan
     * tertulis dan dijelaskan di layar APK:
     *  - Lokasi/GPS dikunci menyala dan tidak bisa dimatikan pemegang HP selama aplikasi aktif
     *    (DISALLOW_CONFIG_LOCATION + setLocationEnabled). Pelepasan lewat alur "Lepas perangkat".
     *  - Aplikasi tidak bisa dihapus tanpa kode lepas dari admin (setUninstallBlocked).
     * Semua dibungkus try/catch: OEM tertentu bisa menolak sebagian kebijakan tanpa mematikan sisanya.
     */
    private fun applyCompanyLockPolicies(
        dpm: DevicePolicyManager,
        admin: android.content.ComponentName,
        context: Context,
    ) {
        try {
            dpm.setUninstallBlocked(admin, context.packageName, true)
        } catch (e: SecurityException) {
            Log.w(TAG, "blokir uninstall tidak bisa dipasang: ${e.message}")
        }
        // DISALLOW_CONFIG_LOCATION baru ada sejak Android 9 (API 28); setLocationEnabled sejak
        // Android 11 (API 30). Di versi lebih lama, service melaporkan status GPS & meminta staf
        // menyalakannya lagi kalau dimatikan (lihat TrackerForegroundService + dashboard).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                dpm.addUserRestriction(admin, UserManager.DISALLOW_CONFIG_LOCATION)
            } catch (e: SecurityException) {
                Log.w(TAG, "kunci lokasi tidak bisa dipasang: ${e.message}")
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                dpm.setLocationEnabled(admin, true)
            } catch (e: SecurityException) {
                Log.w(TAG, "GPS tidak bisa dinyalakan otomatis: ${e.message}")
            }
        }
    }

    /** Lokasi/GPS sedang dikunci menyala oleh kebijakan Device Owner (tidak bisa dimatikan pengguna)? */
    fun isLocationPolicyLocked(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
            ?: return false
        if (!dpm.isDeviceOwnerApp(context.packageName)) return false
        val um = context.getSystemService(Context.USER_SERVICE) as? UserManager ?: return false
        return um.hasUserRestriction(UserManager.DISALLOW_CONFIG_LOCATION)
    }

    /** Aplikasi sedang dikunci agar tidak bisa dihapus (butuh kode lepas dari admin)? */
    fun isUninstallLocked(context: Context): Boolean {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
            ?: return false
        if (!dpm.isDeviceOwnerApp(context.packageName)) return false
        return try {
            dpm.isUninstallBlocked(TrackerDeviceAdminReceiver.componentName(context), context.packageName)
        } catch (_: SecurityException) {
            false
        }
    }
}
