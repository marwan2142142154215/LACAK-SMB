package com.lacaksmb.tracker.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import com.lacaksmb.tracker.BuildConfig
import com.lacaksmb.tracker.R
import com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver
import com.lacaksmb.tracker.data.DeviceIdentityStore
import com.lacaksmb.tracker.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Foreground service yang wajib selalu hidup ("selalu online") selama APK
 * terpasang & sudah di-enroll. Tahap fondasi ini mengerjakan:
 *  - Koneksi persisten ke gateway (auto-reconnect lewat socket.io-client)
 *  - Notifikasi persisten yang JUJUR (standar android-apk-pro bagian 4:
 *    jangan menyembunyikan diri dari pemilik device)
 *  - Menjalankan perintah 'lock' lewat Device Admin, balas command:ack
 *  - Heartbeat tiap 30 detik berisi posisi GPS + level baterai + SSID WiFi
 *    (terpasang, bukan null) supaya radar dashboard & geofence WiFi/IP
 *    benar-benar berfungsi
 */
class TrackerForegroundService : Service(), GatewaySocketClient.Listener {

    private lateinit var identityStore: DeviceIdentityStore
    private var socketClient: GatewaySocketClient? = null

    private val serviceJob = SupervisorJob()
    private val serviceScope = CoroutineScope(serviceJob)
    private var heartbeatJob: Job? = null

    // Lokasi GPS terbaru dari LocationManager. null sampai perangkat pertama
    // kali melaporkan posisi (atau sampai isi sendiri dari last-known saat
    // heartbeat pertama) — radar dashboard menampilkan posisi begitu ada.
    private var latestLocation: Location? = null
    private var lastKnownSentAt: Long = 0L

    // Penerima lokasi Android 8 s/d 9 (Listener API).
    @Suppress("DEPRECATION")
    private val legacyLocationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            latestLocation = location
        }
    }
    private var gpsUpdatesStarted = false

    override fun onCreate() {
        super.onCreate()
        identityStore = DeviceIdentityStore(applicationContext)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification(status = "Menghubungkan..."))

        serviceScope.launch {
            val snapshot = identityStore.snapshot()
            if (!snapshot.isEnrolled || snapshot.siteCode.isBlank()) {
                stopSelf()
                return@launch
            }

            val client = GatewaySocketClient(snapshot.gatewayUrl, this@TrackerForegroundService)
            socketClient = client
            client.connect(
                deviceUuid = snapshot.deviceUuid,
                siteCode = snapshot.siteCode,
                appBuildVersion = BuildConfig.VERSION_NAME,
            )
        }

        // START_STICKY: minta sistem restart service kalau di-kill karena
        // tekanan memori — konsisten dengan "wajib selalu online".
        return START_STICKY
    }

    override fun onDestroy() {
        heartbeatJob?.cancel()
        stopGpsUpdates()
        socketClient?.disconnect()
        serviceJob.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ---- GatewaySocketClient.Listener ----

    override fun onConnected() {
        updateNotification("Terhubung ke server")
    }

    override fun onDisconnected() {
        updateNotification("Terputus, mencoba menyambung ulang...")
    }

    override fun onAccepted(deviceId: Int, status: String) {
        updateNotification("Aktif memantau (status: $status)")
        startHeartbeat()
        startGpsUpdates()
        // Kirim satu laporan segera supaya radar tidak menunggu interval
        // heartbeat pertama; posisi GPS mungkin tetap null sampai fix pertama.
        serviceScope.launch { sendHeartbeatOnce() }
    }

    override fun onRejected(message: String) {
        updateNotification("Ditolak: $message")
        heartbeatJob?.cancel()
        // Device ditolak server (site code tidak cocok / consent tidak berlaku
        // / dinonaktifkan) — hentikan service, jangan terus mencoba diam-diam.
        stopSelf()
    }

    override fun onCommandPush(commandId: Int?, commandType: String, reasonNote: String?) {
        when (commandType) {
            "lock" -> {
                TrackerDeviceAdminReceiver.lockNow(applicationContext)
                updateNotification("Dikunci oleh admin" + (reasonNote?.let { ": $it" } ?: ""))
            }
            "unlock" -> {
                // Membuka kunci layar tidak bisa diprogram langsung (dilarang
                // sistem Android, hanya lockNow() yang diizinkan Device Admin).
                // "Unlock" di sini berarti mengizinkan app kembali berjalan
                // normal/tidak memblokir UI — ditangani di MainActivity.
                updateNotification("Perintah unlock diterima")
            }
            "locate_now" -> {
                serviceScope.launch { sendHeartbeatOnce() }
            }
        }
        commandId?.let { socketClient?.acknowledgeCommand(it) }
    }

    // ---- Heartbeat ----

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = serviceScope.launch {
            while (true) {
                sendHeartbeatOnce()
                delay(HEARTBEAT_INTERVAL_MS)
            }
        }
    }

    private fun sendHeartbeatOnce() {
        val position = currentPosition()
        socketClient?.sendLocation(
            source = "gps",
            latitude = position.first,
            longitude = position.second,
            bleDistanceMeters = null,
            bleRssi = null,
            batteryLevel = currentBatteryLevel(),
            ssid = currentSsid(),
            ip = null,
        )
    }

    // ---- Lokasi GPS ----

    /**
     * Mulai mendengarkan pembaruan lokasi. Cadence hemat baterai: 60 detik
     * / 10 meter (kalau device diam, Android tidak memanggil callback).
     * Provider GPS + NETWORK (NETWORK sebagai cadangan di dalam ruangan).
     * Dipakai Listener API lintas versi (deprecated sejak API 30 tapi tetap
     * didukung penuh di Android 8-16) karena API Consumer/Builder baru tidak
     * tersedia penuh di compileSdk 36. Dipanggil hanya setelah device
     * diterima server (device yang ditolak tidak akan diancam lokasinya).
     */
    @android.annotation.SuppressLint("MissingPermission")
    private fun startGpsUpdates() {
        if (gpsUpdatesStarted) return
        val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        gpsUpdatesStarted = true

        @Suppress("DEPRECATION")
        lm.requestLocationUpdates(
            LocationManager.GPS_PROVIDER, 60_000L, 10f,
            legacyLocationListener, Looper.getMainLooper(),
        )
        @Suppress("DEPRECATION")
        lm.requestLocationUpdates(
            LocationManager.NETWORK_PROVIDER, 60_000L, 10f,
            legacyLocationListener, Looper.getMainLooper(),
        )
    }

    @Suppress("DEPRECATION")
    private fun stopGpsUpdates() {
        if (!gpsUpdatesStarted) return
        gpsUpdatesStarted = false
        try {
            val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
            lm.removeUpdates(legacyLocationListener)
        } catch (_: SecurityException) {
            // Service sudah berhenti dan izin mungkin sudah tidak relevan — abaikan.
        }
    }

    /**
     * Posisi terbaru untuk dikirim: pakai update terakhir, atau sekali per
     * menit coba ambil last-known (berguna saat pertama kali start supaya
     * radar langsung dapat titik tanpa menunggu fix GPS pertama).
     */
    @android.annotation.SuppressLint("MissingPermission")
    private fun currentPosition(): Pair<Double?, Double?> {
        if (latestLocation == null && System.currentTimeMillis() - lastKnownSentAt > 60_000L) {
            val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
            val last = try {
                lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                    ?: lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
            } catch (_: SecurityException) {
                null
            }
            if (last != null) {
                latestLocation = last
                lastKnownSentAt = System.currentTimeMillis()
            }
        }
        return (latestLocation?.latitude) to (latestLocation?.longitude)
    }

    /**
     * Nama WiFi yang sedang dihubungkan — dipakai server untuk aturan
     * geofence "wifi di luar whitelist → pelanggaran". null kalau tidak
     * tersambung WiFi atau izin tidak cukup.
     */
    @Suppress("DEPRECATION")
    private fun currentSsid(): String? {
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return null
        val ssid = try {
            wifi.connectionInfo?.ssid
        } catch (_: SecurityException) {
            null
        }
        if (ssid.isNullOrBlank() || ssid == "<unknown ssid>") return null
        return ssid.trim().removePrefix("\"").removeSuffix("\"")
    }

    private fun currentBatteryLevel(): Int? {
        val bm = getSystemService(BATTERY_SERVICE) as? BatteryManager ?: return null
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (level in 0..100) level else null
    }

    // ---- Notifikasi ----

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_tracking),
                NotificationManager.IMPORTANCE_LOW,
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(status: String): Notification {
        val tapIntent = Intent(this, MainActivity::class.java)
        val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_IMMUTABLE
        } else {
            0
        }
        val pendingIntent = PendingIntent.getActivity(this, 0, tapIntent, pendingFlags)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_tracking_title))
            .setContentText(status)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build()
    }

    private fun updateNotification(status: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(status))
    }

    companion object {
        private const val CHANNEL_ID = "tracker_active"
        private const val NOTIFICATION_ID = 1001
        private const val HEARTBEAT_INTERVAL_MS = 30_000L

        fun start(context: android.content.Context) {
            val intent = Intent(context, TrackerForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
