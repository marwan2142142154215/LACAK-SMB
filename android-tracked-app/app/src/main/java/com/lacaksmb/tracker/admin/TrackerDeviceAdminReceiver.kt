package com.lacaksmb.tracker.admin

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.widget.Toast

/**
 * Jalur resmi Android untuk kemampuan lock-screen jarak jauh. Hanya memakai force-lock (lihat
 * res/xml/device_admin_policies.xml) — tidak minta kemampuan wipe/kamera/dll yang tidak dipakai.
 *
 * Receiver yang sama dipakai sebagai komponen Device Owner saat HP aset perusahaan dipasang lewat
 * QR provisioning (lihat ProvisioningActivities.kt & docs/provisioning-device-owner.md).
 */
class TrackerDeviceAdminReceiver : DeviceAdminReceiver() {

    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        Toast.makeText(context, "Device Admin aktif — lock jarak jauh bisa dipakai", Toast.LENGTH_SHORT).show()
    }

    override fun onDisabled(context: Context, intent: Intent) {
        super.onDisabled(context, intent)
        Toast.makeText(context, "Device Admin dinonaktifkan — lock jarak jauh tidak akan berfungsi", Toast.LENGTH_LONG).show()
    }

    /** Android 8-9 (dan jalur lama): provisioning Device Owner selesai. */
    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        super.onProfileProvisioningComplete(context, intent)
        completeDeviceOwnerSetup(context)
    }

    companion object {
        fun componentName(context: Context): ComponentName =
            ComponentName(context, TrackerDeviceAdminReceiver::class.java)

        fun isActive(context: Context): Boolean {
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            return dpm.isAdminActive(componentName(context))
        }

        /**
         * Kalau aplikasi ini dipromosikan menjadi DEVICE OWNER, aktifkan
         * lock-task penuh untuk package sendiri: selama terpin, gesture
         * "tekan-tahan Back + Recents" untuk unpin DIMATIKAN TOTAL oleh sistem
         * (bukan sekadar disembunyikan), dan seluruh fitur sistem (home,
         * overview, notification shade) dimatikan. Inilah satu-satunya cara
         * membuat mode lock benar-benar tidak bisa di-bypass.
         *
         * Tanpa Device Owner, fungsi ini tidak melakukan apa pun dan
         * startLockTask() tetap berjalan sebagai screen-pinning biasa
         * (yang masih bisa keluar lewat kombinasi tombol — karena itu kami
         * juga menyembunyikan tombol navigasi di LockActivity).
         *
         * Cara jadikan Device Owner: QR provisioning dari menu Build APK
         * (HP baru di-reset pabrik), atau lewat adb di HP tanpa akun:
         *   adb shell dpm set-device-owner \
         *     com.lacaksmb.tracker.debug/com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver
         */
        fun enableFullLockTaskIfDeviceOwner(context: Context): Boolean {
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            val admin = componentName(context)
            if (!dpm.isDeviceOwnerApp(context.packageName)) return false
            return try {
                dpm.setLockTaskPackages(admin, arrayOf(context.packageName))
                // setLockTaskFeatures baru ada sejak API 28 (Android 9) -- app
                // ini minSdk 26 (Android 8.0/8.1). Memanggilnya di API <28
                // melempar NoSuchMethodError, yaitu Error bukan Exception, jadi
                // TIDAK tertangkap oleh catch (_: Exception) di bawah --
                // sebelumnya ini bisa meng-crash service begitu device jadi
                // Device Owner di HP Android 8/8.1. Di API <28, lock task tanpa
                // panggilan ini tetap jalan (fitur sistem bawaan sedikit lebih
                // longgar, tapi gesture unpin standar tetap dimatikan karena
                // app sudah Device Owner).
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    // 0 = semua fitur sistem (home/overview/shade) dimatikan.
                    dpm.setLockTaskFeatures(admin, 0)
                }
                true
            } catch (_: Exception) {
                // OEM/user-profile edge cases: biarkan startLockTask() biasa
                // yang mengambil alih.
                false
            }
        }

        /** Mengunci layar sekarang. Memerlukan Device Admin sudah aktif. */
        fun lockNow(context: Context): Boolean {
            if (!isActive(context)) return false
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            return try {
                dpm.lockNow()
                true
            } catch (_: SecurityException) {
                false
            }
        }
    }
}
