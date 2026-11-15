package com.lacaksmb.tracker.admin

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.os.Build
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
        return true
    }
}
