package com.lacaksmb.tracker.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.lacaksmb.tracker.BuildConfig
import com.lacaksmb.tracker.R
import com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver
import com.lacaksmb.tracker.data.DeviceIdentityStore
import com.lacaksmb.tracker.data.DeviceLockStore
import com.lacaksmb.tracker.ui.LockActivity
import com.lacaksmb.tracker.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Foreground service yang wajib selalu hidup ("selalu online") selama APK
 * terpasang & sudah di-enroll. Mengerjakan:
 *  - Koneksi persisten ke gateway (auto-reconnect lewat socket.io-client)
 *  - Notifikasi persisten yang JUJUR (standar android-apk-pro bagian 4:
 *    jangan menyembunyikan diri dari pemilik device)
 *  - Menjalankan perintah 'lock': BUKAN mematikan/mem-brick device, tapi
 *    membuka LockActivity layar penuh "SEGERA KEMBALI KE TEMPAT ANDA,
 *    BOSKU" dengan kolom OTP self-unlock. LockActivity memakai
 *    startLockTask() (screen pinning resmi Android) sehingga tombol Home
 *    DAN Recents benar-benar DINONAKTIFKAN oleh sistem selama locked —
 *    bukan cuma ditutupi tampilan. Status kunci disimpan PERSISTEN di
 *    DeviceLockStore, dan watchdog di bawah + LockDefenseReceiver memasang
 *    ulang LockActivity setiap kali ada upaya keluar (anti-skip).
 *  - Heartbeat tiap 30 detik berisi posisi GPS + level baterai + SSID WiFi
 *    supaya radar dashboard & geofence WiFi/IP benar-benar berfungsi
 */
class TrackerForegroundService : Service(), GatewaySocketClient.Listener {

    private lateinit var identityStore: DeviceIdentityStore
    private lateinit var lockStore: DeviceLockStore
    private var socketClient: GatewaySocketClient? = null
    private val bleAdvertiser by lazy { BleBeaconAdvertiser(applicationContext) }
    private val bleScanner by lazy { BleBeaconScanner(applicationContext) }

    // UUID anchor TETAP yang sedang dipantau (kalau ada) -- dipakai supaya
    // strongestOtherReading() tidak ikut melaporkan anchor tetap itu sendiri
    // sebagai "APK Master terdekat".
    @Volatile
    private var currentAnchorUuid: String? = null

    // Watchdog kunci: selama status locked, pasang ulang LockActivity tiap
    // beberapa detik (jaring pengaman kalau user berhasil pindah layar
    // walau sudah dipin — mis. OEM yang membatasi screen pinning).
    // SENGAJA TIDAK memanggil enforceLockNow() di sini — DevicePolicyManager
    // .lockNow() benar-benar mematikan layar seperti tombol power (lalu
    // minta PIN/pola device kalau ada), yang kalau dipanggil berulang
    // bareng LockActivity (yang men-turnScreenOn lagi) menyebabkan layar
    // hidup-mati-hidup-mati — lihat catatan di enforceLockAndWatch().
    private val lockWatchdogHandler = Handler(Looper.getMainLooper())
    private val lockWatchdogRunnable: Runnable = object : Runnable {
        override fun run() {
            serviceScope.launch {
                val lock = lockStore.snapshot()
                if (lock.adminLocked) {
                    LockActivity.launch(applicationContext, lock.reason)
                    lockWatchdogHandler.postDelayed(lockWatchdogRunnable, LOCK_WATCHDOG_MS)
                }
            }
        }
    }

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

    // Instance receiver anti-bypass, didaftarkan DINAMIS (bukan manifest —
    // ACTION_SCREEN_ON/ACTION_USER_PRESENT adalah broadcast implisit yang
    // diabaikan Android kalau didaftarkan lewat manifest sejak API 26).
    // Service ini selalu hidup, jadi selalu bisa mendaftar ulang di onCreate.
    private val lockDefenseReceiver = LockDefenseReceiver()
    private var lockDefenseRegistered = false

    /**
     * Laporan cepat saat jarak BLE melewati radius. Server tetap SATU-SATUNYA
     * pihak yang memutuskan lock/unlock (lihat geofence_evaluator) -- di sini
     * kita hanya mengirim laporan posisi LEBIH CEPAT daripada heartbeat 30
     * detik, supaya deteksi keluar/masuk radius jadi nyaris real-time.
     *
     * Jeda antar laporan dibatasi (BIAS_REPORT_MIN_INTERVAL_MS) supaya noise
     * RSSI yang bolak-balik di ambang tidak membanjiri server. Saat jeda ini
     * dilewati, laporan terakhir yang sempat tertahan ikut terkirim -- jadi
     * bukti "keluar radius" tidak hilang cuma karena sempat ada satu paket
     * yang menyimpang.
     */
    private var pendingCrossingReport: Pair<Boolean, Double?>? = null
    private var lastCrossingReportAt = 0L

    private val bleCrossingListener = object : BleBeaconScanner.CrossingListener {
        @Synchronized
        override fun onCrossingChanged(isInsideRadius: Boolean, distanceMeters: Double?) {
            pendingCrossingReport = isInsideRadius to distanceMeters
            flushCrossingReport(System.currentTimeMillis())
        }
    }

    private val crossingFlushHandler = Handler(Looper.getMainLooper())
    private val crossingFlushRunnable = Runnable { flushCrossingReport(System.currentTimeMillis()) }

    /**
     * Kirim laporan posisi yang tertahan (kalau ada). Dipanggil dari callback
     * scan BLE (thread scanner) maupun dari handler (main thread), jadi
     * seluruh akses ke pendingCrossingReport & lastCrossingReportAt dijaga
     * lock yang sama. Saat laporan masih ditahan karena jeda minimum,
     * jadwalkan flush ulang tepat setelah jeda itu berlalu -- bukti keluar/
     * masuk radius tidak pernah hilang, cuma tertunda sebentar saat noise.
     */
    @Synchronized
    private fun flushCrossingReport(now: Long) {
        crossingFlushHandler.removeCallbacks(crossingFlushRunnable)
        if (pendingCrossingReport == null) return

        val elapsed = now - lastCrossingReportAt
        if (elapsed < BIAS_REPORT_MIN_INTERVAL_MS) {
            crossingFlushHandler.postDelayed(
                crossingFlushRunnable,
                BIAS_REPORT_MIN_INTERVAL_MS - elapsed,
            )
            return
        }

        pendingCrossingReport = null
        lastCrossingReportAt = now

        val position = currentPosition()
        // SENGAJA TIDAK fallback ke pending.second (jarak di SAAT zona
        // berubah) kalau bleReading sekarang null -- itu bug yang sempat
        // menyebabkan unlock palsu di produksi: pending.second bisa berupa
        // nilai "dekat" yang sudah basi (tertahan sampai BIAS_REPORT_MIN_
        // INTERVAL_MS, bisa beberapa detik), padahal bleReading() null
        // berarti scanner SEKARANG tidak punya data sama sekali (anchor baru
        // hilang lagi). Melaporkan null di sini (bukan nilai basi) membuat
        // server menganggapnya "anchor tidak terdeteksi" -- default aman,
        // bukan bukti palsu "masih dekat".
        val bleReading = bleScanner.latestReading()
        val nearbyBeacon = bleScanner.strongestOtherReading(currentAnchorUuid)
        socketClient?.sendLocation(
            source = if (bleReading != null) "ble" else "gps",
            latitude = position.first,
            longitude = position.second,
            bleDistanceMeters = bleReading?.second,
            bleRssi = bleReading?.first,
            batteryLevel = currentBatteryLevel(),
            ssid = currentSsid(),
            ip = null,
            nearbyBeaconUuid = nearbyBeacon?.first,
            nearbyBeaconDistanceMeters = nearbyBeacon?.third,
        )
    }

    override fun onCreate() {
        super.onCreate()
        identityStore = DeviceIdentityStore(applicationContext)
        lockStore = DeviceLockStore(applicationContext)
        createNotificationChannel()
        registerLockDefenseReceiver()
    }

    private fun registerLockDefenseReceiver() {
        if (lockDefenseRegistered) return
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        ContextCompat.registerReceiver(
            this,
            lockDefenseReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        lockDefenseRegistered = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification(status = "Menghubungkan..."))

        // Dipanggil LockDefenseReceiver saat ada upaya keluar dari LockActivity
        // padahal status masih locked: pasang ulang LockActivity + watchdog.
        if (intent?.action == ACTION_ENSURE_LOCKED) {
            serviceScope.launch {
                val lock = lockStore.snapshot()
                if (lock.adminLocked) {
                    enforceLockAndWatch(lock.reason)
                }
            }
        }

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
                deviceSecret = snapshot.deviceSecret,
            )

            // Terapkan ulang status kunci kalau device sedang dikunci admin —
            // berlaku setelah reboot / service di-restart (mis. user mencoba
            // "menghidupkan ulang" sebagai cara menyingkirkan kunci).
            val lock = lockStore.snapshot()
            if (lock.adminLocked) {
                enforceLockAndWatch(lock.reason)
            }
        }

        // START_STICKY: minta sistem restart service kalau di-kill karena
        // tekanan memori — konsisten dengan "wajib selalu online".
        return START_STICKY
    }

    override fun onDestroy() {
        heartbeatJob?.cancel()
        lockWatchdogHandler.removeCallbacks(lockWatchdogRunnable)
        crossingFlushHandler.removeCallbacks(crossingFlushRunnable)
        pendingCrossingReport = null
        stopGpsUpdates()
        bleAdvertiser.stop()
        bleScanner.stop()
        socketClient?.disconnect()
        serviceJob.cancel()
        if (lockDefenseRegistered) {
            try {
                unregisterReceiver(lockDefenseReceiver)
            } catch (_: IllegalArgumentException) {
                // Sudah ter-unregister — aman diabaikan.
            }
            lockDefenseRegistered = false
        }
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

    override fun onAccepted(deviceId: Int, status: String, bleAnchorUuid: String?, bleMaxDistanceMeters: Double?) {
        updateNotification("Aktif memantau (status: $status)")
        startHeartbeat()
        startGpsUpdates()
        serviceScope.launch {
            bleAdvertiser.start(identityStore.snapshot().deviceUuid)
        }
        // Scan BLE SELALU jalan tanpa filter (lihat BleBeaconScanner) -- dipakai
        // DUA hal independen: anchor tetap (bleAnchorUuid, kalau site ini punya
        // aturan dengan anchor device dikonfigurasi) DAN mendeteksi APK Master
        // yang kebetulan dekat (anchor bergerak, lihat strongestOtherReading
        // di heartbeat). Jadi scan tetap dinyalakan walau tidak ada anchor tetap.
        currentAnchorUuid = bleAnchorUuid?.takeIf { it.isNotBlank() }
        bleScanner.start()
        if (!bleAnchorUuid.isNullOrBlank()) {
            bleScanner.setRadiusMeters(bleMaxDistanceMeters)
            bleScanner.setCrossingListener(bleCrossingListener)
            bleScanner.startScanningFor(bleAnchorUuid)
        } else {
            bleScanner.setRadiusMeters(null)
            bleScanner.setCrossingListener(null)
            bleScanner.clearAnchor()
        }
        // TIDAK perlu kirim heartbeat manual di sini: startHeartbeat() di atas
        // sudah mengirim laporan pertama secepatnya (loop mengirim SEBELUM
        // delay pertama). Dulu ada launch { sendHeartbeatOnce() } tambahan di
        // titik ini -- setiap (re)connect menghasilkan DUA device:location pada
        // detik yang sama: dua log pelanggaran kembar kalau anchor belum
        // terdeteksi (2 pesan Telegram + bisa memicu lock dobel).
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
                // BUKAN mematikan device — kunci disimpan PERSISTEN, LockActivity
                // layar penuh "SEGERA KEMBALI KE TEMPAT ANDA, BOSKU" dibuka dengan
                // screen pinning (Home & Recents nonaktif) + kolom OTP, dan
                // watchdog menjaganya supaya tidak bisa di-skip.
                serviceScope.launch {
                    lockStore.setLocked(reasonNote)
                    enforceLockAndWatch(reasonNote)
                }
            }
            "unlock" -> {
                // Unlock dari ADMIN (dashboard/bot Telegram) — LockActivity yang
                // sedang tampil otomatis menutup diri lewat watchdog pollingnya
                // sendiri begitu DeviceLockStore terbaca tidak locked lagi.
                serviceScope.launch {
                    lockStore.clear()
                    lockWatchdogHandler.removeCallbacks(lockWatchdogRunnable)
                    updateNotification("Perintah unlock diterima — perangkat bisa dipakai")
                }
            }
            "locate_now" -> {
                serviceScope.launch { sendHeartbeatOnce() }
            }
        }
        commandId?.let { socketClient?.acknowledgeCommand(it) }
    }

    // ---- Lock jarak jauh (anti-skip, dengan self-unlock OTP) ----

    /**
     * Kunci layar SEKARANG via Device Admin — HANYA dipakai sebagai jaring
     * pengaman kalau LockActivity sama sekali gagal dibuka (mis. OEM yang
     * memblokir activity dari background). JANGAN dipanggil rutin/berkala:
     * dpm.lockNow() benar-benar mematikan layar seperti tombol power (lalu
     * minta PIN/pola device kalau sudah di-set), jadi kalau dipanggil
     * berulang bareng LockActivity yang menyalakan layar lagi, hasilnya
     * layar hidup-mati-hidup-mati — persis bug yang pernah terjadi di sini.
     */
    private fun enforceLockNowFallback() {
        val ok = TrackerDeviceAdminReceiver.lockNow(applicationContext)
        Log.i(TAG, "enforceLockNowFallback -> $ok")
    }

    /** Pasang LockActivity (screen pinning) + mulai watchdog pasang-ulang. */
    private fun enforceLockAndWatch(reason: String?) {
        updateNotification(
            "Terkunci — segera kembali ke lokasi Anda" +
                (reason?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""),
        )
        try {
            LockActivity.launch(applicationContext, reason)
        } catch (_: Exception) {
            enforceLockNowFallback()
        }
        lockWatchdogHandler.removeCallbacks(lockWatchdogRunnable)
        lockWatchdogHandler.postDelayed(lockWatchdogRunnable, LOCK_WATCHDOG_MS)
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
        val bleReading = bleScanner.latestReading()
        val nearbyBeacon = bleScanner.strongestOtherReading(currentAnchorUuid)
        socketClient?.sendLocation(
            source = if (bleReading != null) "ble" else "gps",
            latitude = position.first,
            longitude = position.second,
            bleDistanceMeters = bleReading?.second,
            bleRssi = bleReading?.first,
            batteryLevel = currentBatteryLevel(),
            ssid = currentSsid(),
            ip = null,
            nearbyBeaconUuid = nearbyBeacon?.first,
            nearbyBeaconDistanceMeters = nearbyBeacon?.third,
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
        // 15 detik (dulu 30) -- auto-unlock butuh beberapa heartbeat berturut
        // yang semuanya aman (lihat UNLOCK_SAFE_STREAK_REQUIRED di
        // geofence_evaluator.ts); dengan heartbeat 30 detik, waktu tunggu
        // unlock setelah benar-benar kembali bisa sampai ~90 detik, terasa
        // "macet"/tidak pernah terbuka buat user yang menunggu di depan HP --
        // 15 detik memangkas itu jadi ~30 detik tanpa mengorbankan konfirmasi
        // berulang (masih bukan auto-unlock dari satu bacaan saja).
        private const val HEARTBEAT_INTERVAL_MS = 15_000L

        /**
         * Jeda minimum antar laporan cepat dari perubahan zona BLE. Melindungi
         * dari noise RSSI yang bolak-balik di ambang (bisa berpuluh kali per
         * menit) supaya tidak membanjiri server tanpa mengorbankan deteksi
         * keluar/masuk radius yang nyaris real-time.
         */
        private const val BIAS_REPORT_MIN_INTERVAL_MS = 3_000L

        private const val TAG = "TrackerLock"
        private const val LOCK_WATCHDOG_MS = 5_000L

        /** Aksi start service dari LockDefenseReceiver: pasang ulang LockActivity. */
        const val ACTION_ENSURE_LOCKED = "com.lacaksmb.tracker.action.ENSURE_LOCKED"

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
