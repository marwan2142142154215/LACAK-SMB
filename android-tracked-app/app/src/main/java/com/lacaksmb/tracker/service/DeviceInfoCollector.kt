package com.lacaksmb.tracker.service

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.telephony.TelephonyManager
import com.lacaksmb.tracker.BuildConfig
import com.lacaksmb.tracker.admin.DeviceOwnerSetup
import com.lacaksmb.tracker.setup.SetupChecks
import org.json.JSONObject

/**
 * Detail perangkat yang dikirim ke kantor (event `device:info`). Daftar ini SAMA PERSIS dengan yang
 * diungkapkan ke pemegang HP di layar APK (MainActivity, kartu "Data yang dikirim"):
 * merek & model, versi Android, versi aplikasi, baterai & status cas, jenis jaringan + nama
 * operator, sisa penyimpanan, dan status izin aplikasi ini.
 *
 * TIDAK dikumpulkan: isi pesan, kontak, riwayat panggilan, foto/berkas, daftar atau isi aplikasi
 * lain, nomor telepon, IMEI. Semua nilai di bawah tersedia tanpa izin tambahan.
 */
object DeviceInfoCollector {

    fun collect(context: Context): JSONObject {
        val appContext = context.applicationContext
        val battery = batteryState(appContext)
        val network = networkType(appContext)
        val storage = storageMb()
        return JSONObject().apply {
            put("manufacturer", Build.MANUFACTURER)
            put("model", Build.MODEL)
            put("androidVersion", Build.VERSION.RELEASE)
            put("sdkInt", Build.VERSION.SDK_INT)
            put("appVersionName", BuildConfig.VERSION_NAME)
            put("appVersionCode", BuildConfig.VERSION_CODE)
            battery.first?.let { put("batteryLevel", it) }
            battery.second?.let { put("isCharging", it) }
            put("networkType", network)
            carrierName(appContext)?.let { put("carrierName", it) }
            storage?.let {
                put("storageFreeMb", it.first)
                put("storageTotalMb", it.second)
            }
            put("permissions", SetupChecks.permissionState(appContext))
            // Kebijakan kunci HP aset perusahaan + status GPS saat ini (lihat DeviceOwnerSetup).
            // GPS dilaporkan untuk HP non-Device-Owner yang lokasinya masih bisa dimatikan pemegang HP.
            put("locationServiceOn", SetupChecks.isLocationServiceOn(appContext))
            put("locationPolicyLocked", DeviceOwnerSetup.isLocationPolicyLocked(appContext))
            put("uninstallLocked", DeviceOwnerSetup.isUninstallLocked(appContext))
        }
    }

    /** (persen, sedang dicas) dari broadcast sticky ACTION_BATTERY_CHANGED -- tanpa izin. */
    fun batteryState(context: Context): Pair<Int?, Boolean?> {
        val intent: Intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?: return null to null
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val percent = if (level >= 0 && scale > 0) (level * 100 / scale).coerceIn(0, 100) else null
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL ||
            plugged != 0
        return percent to charging
    }

    private fun networkType(context: Context): String {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return "other"
        val capabilities = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "none"
        return when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            else -> "other"
        }
    }

    /** Nama operator jaringan seluler (mis. "Telkomsel"); tidak butuh izin telepon. */
    private fun carrierName(context: Context): String? {
        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return null
        return tm.networkOperatorName?.trim()?.takeIf { it.isNotEmpty() }
            ?: tm.simOperatorName?.trim()?.takeIf { it.isNotEmpty() }
    }

    /** (sisa, total) penyimpanan internal dalam MB. */
    private fun storageMb(): Pair<Long, Long>? = try {
        val stat = StatFs(Environment.getDataDirectory().path)
        (stat.availableBytes / BYTES_PER_MB) to (stat.totalBytes / BYTES_PER_MB)
    } catch (_: IllegalArgumentException) {
        null
    }

    private const val BYTES_PER_MB = 1024L * 1024L
}
