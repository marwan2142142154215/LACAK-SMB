package com.lacaksmb.tracker.admin

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.widget.Toast

/**
 * Jalur resmi Android untuk kemampuan lock-screen jarak jauh. Tahap fondasi
 * ini hanya memakai force-lock (lihat res/xml/device_admin_policies.xml) —
 * tidak minta kemampuan wipe/kamera/dll yang tidak dipakai.
 */
class TrackerDeviceAdminReceiver : DeviceAdminReceiver() {

    override fun onEnabled(context: Context, intent: android.content.Intent) {
        super.onEnabled(context, intent)
        Toast.makeText(context, "Device Admin aktif — lock jarak jauh bisa dipakai", Toast.LENGTH_SHORT).show()
    }

    override fun onDisabled(context: Context, intent: android.content.Intent) {
        super.onDisabled(context, intent)
        Toast.makeText(context, "Device Admin dinonaktifkan — lock jarak jauh tidak akan berfungsi", Toast.LENGTH_LONG).show()
    }

    companion object {
        fun componentName(context: Context): ComponentName =
            ComponentName(context, TrackerDeviceAdminReceiver::class.java)

        fun isActive(context: Context): Boolean {
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            return dpm.isAdminActive(componentName(context))
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
