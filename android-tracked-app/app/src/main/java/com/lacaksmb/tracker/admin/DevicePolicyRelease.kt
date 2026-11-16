package com.lacaksmb.tracker.admin

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.os.Build
import android.os.UserManager
import android.util.Log

/**
 * Melepas perangkat setelah staf memasukkan "kode lepas perangkat" dari admin (sudah diverifikasi
 * backend, lihat DeviceOtpApi.verifyRelease / DeviceOtpController.release). Urutannya penting:
 * kebijakan kunci DICABUT DULU, baru status Device Owner/Admin dilepas -- clearDeviceOwnerApp ditolak
 * sistem kalau masih ada pembatasan pengguna atau lock-task yang aktif.
 *
 * Setelah ini lokasi bisa dimatikan lagi dan aplikasi bisa dihapus seperti aplikasi biasa.
 */
object DevicePolicyRelease {
    private const val TAG = "DevicePolicyRelease"

    /** true kalau status admin/owner benar-benar sudah dilepas (atau memang tidak terpasang). */
    @Suppress("DEPRECATION") // clearDeviceOwnerApp: tidak ada pengganti untuk melepas Device Owner.
    fun release(context: Context): Boolean {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
            ?: return false
        val admin = TrackerDeviceAdminReceiver.componentName(context)
        val packageName = context.packageName

        if (dpm.isDeviceOwnerApp(packageName)) {
            runCatching { dpm.setUninstallBlocked(admin, packageName, false) }
                .onFailure { Log.w(TAG, "gagal mencabut blokir uninstall: ${it.message}") }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                runCatching { dpm.clearUserRestriction(admin, UserManager.DISALLOW_CONFIG_LOCATION) }
                    .onFailure { Log.w(TAG, "gagal mencabut kunci lokasi: ${it.message}") }
            }
            runCatching { dpm.setLockTaskPackages(admin, emptyArray()) }
            return try {
                dpm.clearDeviceOwnerApp(packageName)
                true
            } catch (e: Exception) {
                Log.w(TAG, "gagal melepas Device Owner: ${e.message}")
                false
            }
        }

        if (dpm.isAdminActive(admin)) {
            return try {
                dpm.removeActiveAdmin(admin)
                true
            } catch (e: SecurityException) {
                Log.w(TAG, "gagal melepas Device Admin: ${e.message}")
                false
            }
        }

        // Tidak ada status admin/owner yang perlu dilepas.
        return true
    }
}
