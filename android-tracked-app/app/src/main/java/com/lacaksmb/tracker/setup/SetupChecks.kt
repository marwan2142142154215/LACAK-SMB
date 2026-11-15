package com.lacaksmb.tracker.setup

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver
import org.json.JSONObject

/**
 * Pemeriksaan izin & setelan yang dibutuhkan APK Pelacak -- satu sumber kebenaran untuk layar
 * panduan (MainActivity), laporan status izin ke dashboard (DeviceInfoCollector), dan service.
 * Semua dibaca langsung dari sistem setiap kali dipanggil, jadi izin yang dicabut pemegang HP
 * setelah instalasi langsung terdeteksi.
 */
object SetupChecks {

    fun hasForegroundLocation(context: Context): Boolean =
        granted(context, Manifest.permission.ACCESS_FINE_LOCATION) ||
            granted(context, Manifest.permission.ACCESS_COARSE_LOCATION)

    fun hasPreciseLocation(context: Context): Boolean =
        granted(context, Manifest.permission.ACCESS_FINE_LOCATION)

    /** Android 10+ mewajibkan izin lokasi latar belakang terpisah; sebelumnya ikut lokasi biasa. */
    fun hasBackgroundLocation(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return hasForegroundLocation(context)
        return granted(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
    }

    /** GPS/lokasi HP sendiri sedang dinyalakan (bukan izin app). */
    fun isLocationServiceOn(context: Context): Boolean {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return false
        return LocationManagerCompat.isLocationEnabled(lm)
    }

    fun hasNotifications(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !granted(context, Manifest.permission.POST_NOTIFICATIONS)
        ) {
            return false
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /** Bluetooth dipakai radar jarak dekat (opsional). Sebelum Android 12 tidak butuh izin runtime. */
    fun hasBluetooth(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return granted(context, Manifest.permission.BLUETOOTH_SCAN) &&
            granted(context, Manifest.permission.BLUETOOTH_CONNECT) &&
            granted(context, Manifest.permission.BLUETOOTH_ADVERTISE)
    }

    fun isDeviceAdmin(context: Context): Boolean = TrackerDeviceAdminReceiver.isActive(context)

    fun isDeviceOwner(context: Context): Boolean {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
            ?: return false
        return dpm.isDeviceOwnerApp(context.packageName)
    }

    fun isBatteryUnrestricted(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    fun hasOverlay(context: Context): Boolean = Settings.canDrawOverlays(context)

    /**
     * Layar kunci bisa dibuka dari latar belakang? Android 10+ memblokir activity yang dibuka dari
     * latar belakang KECUALI app punya izin "tampil di atas aplikasi lain" atau berstatus Device
     * Owner. Tanpa salah satunya perintah lock hanya bisa mematikan layar lewat Device Admin.
     */
    fun canShowLockScreen(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || hasOverlay(context) || isDeviceOwner(context)

    /** Status izin yang dilaporkan ke dashboard (kunci sama dengan DeviceTelemetry di gateway). */
    fun permissionState(context: Context): JSONObject = JSONObject().apply {
        put("location", hasForegroundLocation(context))
        put("backgroundLocation", hasBackgroundLocation(context))
        put("notifications", hasNotifications(context))
        put("bluetooth", hasBluetooth(context))
        put("deviceAdmin", isDeviceAdmin(context))
        put("deviceOwner", isDeviceOwner(context))
        put("batteryUnrestricted", isBatteryUnrestricted(context))
        put("overlay", hasOverlay(context))
    }

    private fun granted(context: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}
