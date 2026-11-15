package com.lacaksmb.tracker.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.location.Location
import android.net.ConnectivityManager
import android.net.Network
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.lacaksmb.tracker.BuildConfig
import com.lacaksmb.tracker.R
import com.lacaksmb.tracker.admin.DeviceOwnerSetup
import com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver
import com.lacaksmb.tracker.data.CommandLedger
import com.lacaksmb.tracker.data.DeviceIdentityStore
import com.lacaksmb.tracker.data.DeviceLockStore
import com.lacaksmb.tracker.network.DeviceEnrollmentApi
import com.lacaksmb.tracker.setup.SetupChecks
import com.lacaksmb.tracker.ui.LockActivity
import com.lacaksmb.tracker.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

/**
 * Foreground service yang wajib selalu hidup ("selalu online") selama APK
 * terpasang & sudah di-enroll. Mengerjakan:
 *  - Koneksi persisten ke gateway (auto-reconnect lewat socket.io-client, plus sambung ulang
 *    seketika saat jaringan HP tersedia lagi)
 *  - Notifikasi persisten yang JUJUR (standar android-apk-pro bagian 4:
 *    jangan menyembunyikan diri dari pemilik device)
 *  - Menjalankan perintah dari dashboard dan MELAPORKAN hasilnya (diterima → dijalankan/gagal,
 *    lihat handleCommand). Perintah yang dikirim ulang gateway tidak dijalankan dua kali
 *    (CommandLedger).
 *  - Perintah 'lock': BUKAN mematikan/mem-brick device, tapi membuka LockActivity layar penuh
 *    "SEGERA KEMBALI KE TEMPAT ANDA, BOSKU" dengan kolom OTP self-unlock. LockActivity memakai
 *    startLockTask() (screen pinning resmi Android) sehingga tombol Home DAN Recents benar-benar
 *    DINONAKTIFKAN oleh sistem selama locked. Status kunci disimpan PERSISTEN di DeviceLockStore,
 *    dan watchdog di bawah + LockDefenseReceiver memasang ulang LockActivity setiap kali ada upaya
 *    keluar (anti-skip).
 *  - Heartbeat tiap 15 detik berisi posisi (dengan akurasi, sumber & waktu fix) + baterai + SSID
 *    WiFi, dan detail perangkat tiap 5 menit (DeviceInfoCollector) supaya Device & Radar di
 *    dashboard lengkap.
 */
class TrackerForegroundService : Service(), GatewaySocketClient.Listener {

    private lateinit var identityStore: DeviceIdentityStore
    private lateinit var lockStore: DeviceLockStore
    private lateinit var commandLedger: CommandLedger
    private lateinit var locationTracker: LocationTracker
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
    // SENGAJA TIDAK memanggil lockNow() di sini — DevicePolicyManager
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
    private var deviceInfoJob: Job? = null
    private var gatewaySessionJob: Job? = null

    // Instance receiver anti-bypass, didaftarkan DINAMIS (bukan manifest —
    // ACTION_SCREEN_ON/ACTION_USER_PRESENT adalah broadcast implisit yang
    // diabaikan Android kalau didaftarkan lewat manifest sejak API 26).
    // Service ini selalu hidup, jadi selalu bisa mendaftar ulang di onCreate.
    private val lockDefenseReceiver = LockDefenseReceiver()
    private var lockDefenseRegistered = false

    // Jaringan HP kembali (keluar dari mode pesawat, pindah WiFi → seluler, dll.): sambung ulang ke
    // gateway SEKARANG supaya perintah yang menunggu (mis. lock) tidak tertahan sampai jeda reconnect.
    private var networkCallbackRegistered = false
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            socketClient?.reconnectNow()
        }
    }

    /**
     * Laporan cepat saat jarak BLE melewati radius. Server tetap SATU-SATUNYA
     * pihak yang memutuskan lock/unlock (lihat geofence_evaluator) -- di sini
     * kita hanya mengirim laporan posisi LEBIH CEPAT daripada heartbeat, supaya
     * deteksi keluar/masuk radius jadi nyaris real-time.
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

        // SENGAJA TIDAK fallback ke pending.second (jarak di SAAT zona
        // berubah) kalau bleReading sekarang null -- itu bug yang sempat
        // menyebabkan unlock palsu di produksi: pending.second bisa berupa
        // nilai "dekat" yang sudah basi (tertahan sampai BIAS_REPORT_MIN_
        // INTERVAL_MS, bisa beberapa detik), padahal bleReading() null
        // berarti scanner SEKARANG tidak punya data sama sekali (anchor baru
        // hilang lagi). Melaporkan null di sini (bukan nilai basi) membuat
        // server menganggapnya "anchor tidak terdeteksi" -- default aman,
        // bukan bukti palsu "masih dekat".
        sendHeartbeatOnce()
    }

    override fun onCreate() {
        super.onCreate()
        identityStore = DeviceIdentityStore(applicationContext)
        lockStore = DeviceLockStore(applicationContext)
        commandLedger = CommandLedger(applicationContext)
        locationTracker = LocationTracker(applicationContext)
        createNotificationChannel()
        registerLockDefenseReceiver()
        registerNetworkCallback()
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

    private fun registerNetworkCallback() {
        if (networkCallbackRegistered) return
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        try {
            cm.registerDefaultNetworkCallback(networkCallback)
            networkCallbackRegistered = true
        } catch (e: RuntimeException) {
            // Batas jumlah callback per app (TooManyRequestsException) -- reconnect bawaan tetap jalan.
            Log.w(TAG, "network callback tidak bisa didaftarkan: ${e.message}")
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!enterForeground()) {
            stopSelf()
            return START_NOT_STICKY
        }

        // HP aset perusahaan (Device Owner): pastikan izin yang dibutuhkan tetap terpasang.
        DeviceOwnerSetup.applyIfDeviceOwner(applicationContext)

        // Dipanggil LockDefenseReceiver saat ada upaya keluar dari LockActivity
        // padahal status masih locked: pasang ulang LockActivity + watchdog.
        if (intent?.action == ACTION_ENSURE_LOCKED) {
            serviceScope.launch {
                val lock = lockStore.snapshot()
                if (lock.adminLocked) {
                    withContext(Dispatchers.Main) { enforceLockAndWatch(lock.reason) }
                }
            }
        }

        serviceScope.launch {
            val snapshot = identityStore.snapshot()
            if (!snapshot.isEnrolled || snapshot.siteCode.isBlank()) {
                stopSelf()
                return@launch
            }

            // onStartCommand juga dipanggil ulang oleh LockDefenseReceiver & watchdog WorkManager;
            // jangan membuka sesi/klaim kedua kalau yang lama masih berjalan.
            if (socketClient == null && gatewaySessionJob?.isActive != true) {
                startGatewaySession(initialDelayMs = 0L)
            }

            // Terapkan ulang status kunci kalau device sedang dikunci admin —
            // berlaku setelah reboot / service di-restart (mis. user mencoba
            // "menghidupkan ulang" sebagai cara menyingkirkan kunci).
            val lock = lockStore.snapshot()
            if (lock.adminLocked) {
                withContext(Dispatchers.Main) { enforceLockAndWatch(lock.reason) }
            }
        }

        // START_STICKY: minta sistem restart service kalau di-kill karena
        // tekanan memori — konsisten dengan "wajib selalu online".
        return START_STICKY
    }

    /**
     * startForeground bertipe lokasi. Android 14+ menolak (SecurityException) kalau izin lokasi
     * sudah dicabut pemegang HP -- daripada crash berulang (START_STICKY), service berhenti dan
     * notifikasi biasa meminta app dibuka untuk memberi izin lagi.
     */
    private fun enterForeground(): Boolean {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        } else {
            0
        }
        return try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification("Menghubungkan..."), type)
            true
        } catch (e: SecurityException) {
            Log.w(TAG, "foreground service ditolak (izin lokasi?): ${e.message}")
            val manager = getSystemService(NotificationManager::class.java)
            manager.notify(
                NOTIFICATION_ID,
                buildNotification("Izin lokasi dicabut — buka aplikasi Lacak SMB untuk mengaktifkan lagi"),
            )
            TrackerStatus.update("Izin lokasi dicabut", isConnected = false)
            false
        }
    }

    /**
     * Pastikan device punya rahasia (klaim ke backend kalau belum), lalu
     * sambung ke gateway. Klaim diulang berkala karena admin bisa saja baru
     * mendaftarkan device_uuid ini SETELAH app selesai disiapkan, atau baru
     * menekan "daftar ulang" untuk device lama.
     */
    private fun startGatewaySession(initialDelayMs: Long) {
        gatewaySessionJob?.cancel()
        gatewaySessionJob = serviceScope.launch {
            delay(initialDelayMs)
            // APK zero-touch membawa rahasia dari build, jadi tidak perlu klaim.
            identityStore.ensureDeviceSecretFromBuild()
            var snapshot = identityStore.snapshot()
            while (snapshot.deviceSecret.isBlank()) {
                val claimResult = DeviceEnrollmentApi.claim(snapshot.deviceUuid)
                val claimedSecret = claimResult.getOrNull()
                if (claimedSecret != null) {
                    identityStore.saveDeviceSecret(claimedSecret)
                } else {
                    val reason = claimResult.exceptionOrNull()?.message ?: "Device belum didaftarkan admin"
                    Log.w(TAG, "klaim enrollment belum berhasil: $reason")
                    updateNotification("Menunggu pendaftaran oleh admin: $reason", connected = false)
                    delay(ENROLLMENT_RETRY_MS)
                }
                snapshot = identityStore.snapshot()
            }

            val client = GatewaySocketClient(snapshot.gatewayUrl, this@TrackerForegroundService)
            socketClient = client
            client.connect(
                deviceUuid = snapshot.deviceUuid,
                deviceSecret = snapshot.deviceSecret,
                siteCode = snapshot.siteCode,
                appBuildVersion = BuildConfig.VERSION_NAME,
            )
        }
    }

    override fun onDestroy() {
        gatewaySessionJob?.cancel()
        heartbeatJob?.cancel()
        deviceInfoJob?.cancel()
        lockWatchdogHandler.removeCallbacks(lockWatchdogRunnable)
        crossingFlushHandler.removeCallbacks(crossingFlushRunnable)
        pendingCrossingReport = null
        locationTracker.stop()
        bleAdvertiser.stop()
        bleScanner.stop()
        socketClient?.disconnect()
        serviceJob.cancel()
        if (lockDefenseRegistered) {
            try {
                unregisterReceiver(lockDefenseReceiver)
            } catch (e: IllegalArgumentException) {
                // Sudah ter-unregister — tidak fatal, cukup dicatat.
                Log.w(TAG, "lockDefenseReceiver sudah tidak terdaftar: ${e.message}")
            }
            lockDefenseRegistered = false
        }
        if (networkCallbackRegistered) {
            try {
                getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(networkCallback)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "network callback sudah tidak terdaftar: ${e.message}")
            }
            networkCallbackRegistered = false
        }
        TrackerStatus.update("Pemantauan berhenti", isConnected = false)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ---- GatewaySocketClient.Listener ----

    override fun onConnected() {
        updateNotification("Terhubung ke server", connected = true)
    }

    override fun onDisconnected() {
        updateNotification("Terputus, mencoba menyambung ulang...", connected = false)
    }

    override fun onAccepted(deviceId: Int, status: String, bleAnchorUuid: String?, bleMaxDistanceMeters: Double?) {
        updateNotification(
            if (status == "locked") "Aktif — perangkat dalam status terkunci" else "Aktif memantau",
            connected = true,
        )
        // Dipanggil di thread socket.io: urusan LocationManager (Looper) dipindah ke main thread.
        serviceScope.launch(Dispatchers.Main) { locationTracker.start() }
        startHeartbeat()
        startDeviceInfoLoop()
        serviceScope.launch {
            bleAdvertiser.start(BeaconUuid.fromDeviceUuid(identityStore.snapshot().deviceUuid))
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
        updateNotification("Ditolak: $message", connected = false)
        heartbeatJob?.cancel()
        deviceInfoJob?.cancel()
        // Device ditolak server (site code tidak cocok / dinonaktifkan)
        // — hentikan service, jangan terus mencoba diam-diam.
        stopSelf()
    }

    override fun onAuthFailed(message: String, isCredentialProblem: Boolean) {
        heartbeatJob?.cancel()
        deviceInfoJob?.cancel()
        socketClient?.disconnect()
        socketClient = null

        if (!isCredentialProblem) {
            updateNotification("Server sedang bermasalah, mencoba lagi...", connected = false)
            startGatewaySession(initialDelayMs = AUTH_RETRY_MS)
            return
        }

        // Rahasia lokal sudah tidak diakui server (device lama sebelum
        // pembaruan keamanan, atau admin menekan "daftar ulang") — buang dan
        // klaim ulang; klaim baru berhasil setelah admin membuka pendaftaran.
        updateNotification("Perlu didaftarkan ulang: $message", connected = false)
        serviceScope.launch {
            identityStore.clearDeviceSecret()
            startGatewaySession(initialDelayMs = 0L)
        }
    }

    override fun onCommandPush(commandId: Int?, commandType: String, reasonNote: String?) {
        serviceScope.launch { handleCommand(commandId, commandType, reasonNote) }
    }

    // ---- Perintah dari dashboard ----

    /**
     * Konfirmasi terima → jalankan → laporkan hasil. Gateway mengirim ulang perintah yang belum
     * dikonfirmasi; perintah yang sudah pernah dijalankan cukup dilaporkan ulang hasilnya.
     */
    private suspend fun handleCommand(commandId: Int?, commandType: String, reasonNote: String?) {
        if (commandId != null) {
            val done = commandLedger.find(commandId)
            if (done != null) {
                socketClient?.reportCommand(commandId, done.result, done.message)
                return
            }
            socketClient?.reportCommand(commandId, RESULT_RECEIVED)
        }

        val (result, message) = try {
            executeCommand(commandType, reasonNote)
        } catch (e: Exception) {
            Log.e(TAG, "perintah $commandType gagal dijalankan", e)
            RESULT_FAILED to "Kesalahan di HP: ${e.message ?: e.javaClass.simpleName}"
        }
        Log.i(TAG, "perintah #$commandId $commandType -> $result ($message)")

        if (commandId != null) {
            commandLedger.record(CommandLedger.Entry(commandId, result, message))
            socketClient?.reportCommand(commandId, result, message)
        }
    }

    private suspend fun executeCommand(commandType: String, reasonNote: String?): Pair<String, String> =
        when (commandType) {
            "lock" -> executeLock(reasonNote)
            "unlock" -> {
                // Unlock dari ADMIN (dashboard/bot Telegram) — LockActivity yang
                // sedang tampil otomatis menutup diri lewat watchdog pollingnya
                // sendiri begitu DeviceLockStore terbaca tidak locked lagi.
                lockStore.clear()
                lockWatchdogHandler.removeCallbacks(lockWatchdogRunnable)
                updateNotification("Perintah buka kunci diterima — perangkat bisa dipakai")
                RESULT_EXECUTED to "Kunci dibuka, HP bisa dipakai lagi"
            }
            "locate_now" -> executeLocateNow()
            "start_monitor" -> RESULT_EXECUTED to "Pemantauan sudah aktif di HP ini"
            "stop_monitor" -> RESULT_FAILED to
                "Menghentikan pemantauan dari jarak jauh belum didukung APK Pelacak (pemantauan aktif selama aplikasi terpasang)"
            else -> RESULT_FAILED to "Jenis perintah \"$commandType\" tidak dikenal APK versi ini"
        }

    /**
     * BUKAN mematikan device — kunci disimpan PERSISTEN, LockActivity layar penuh dibuka dengan
     * screen pinning (Home & Recents nonaktif) + kolom OTP, dan watchdog menjaganya supaya tidak
     * bisa di-skip. Hasil yang dilaporkan jujur: apakah layar kunci benar-benar tampil.
     */
    private suspend fun executeLock(reasonNote: String?): Pair<String, String> {
        lockStore.setLocked(reasonNote)
        withContext(Dispatchers.Main) { enforceLockAndWatch(reasonNote) }

        if (!SetupChecks.canShowLockScreen(applicationContext)) {
            // Android 10+ memblokir activity dari latar belakang tanpa izin "tampil di atas
            // aplikasi lain" -- matikan layar lewat Device Admin sebagai pengaman minimum.
            return if (TrackerDeviceAdminReceiver.lockNow(applicationContext)) {
                RESULT_EXECUTED to "Layar HP dikunci lewat Device Admin; layar peringatan belum bisa tampil " +
                    "karena izin \"tampil di atas aplikasi lain\" belum diberikan"
            } else {
                RESULT_FAILED to "HP menerima perintah tapi tidak bisa mengunci: Device Admin dan izin " +
                    "\"tampil di atas aplikasi lain\" belum aktif di HP"
            }
        }

        // Tunggu LockActivity benar-benar tampil (onResume) sebelum melapor.
        val deadline = System.currentTimeMillis() + LOCK_CONFIRM_TIMEOUT_MS
        while (!LockActivity.isShowing && System.currentTimeMillis() < deadline) delay(250)
        return if (LockActivity.isShowing) {
            RESULT_EXECUTED to "Layar kunci tampil di HP"
        } else {
            RESULT_EXECUTED to "Status kunci aktif di HP; layar kunci belum terkonfirmasi tampil " +
                "(dibuka ulang otomatis tiap ${LOCK_WATCHDOG_MS / 1000} detik)"
        }
    }

    /** Ambil posisi BARU (sampai 30 detik), kirim, plus detail perangkat terkini. */
    private suspend fun executeLocateNow(): Pair<String, String> {
        val fresh = locationTracker.freshFix(LOCATE_TIMEOUT_MS)
        val location = fresh ?: locationTracker.current()
        sendHeartbeatOnce(location)
        socketClient?.sendDeviceInfo(DeviceInfoCollector.collect(applicationContext))

        return when {
            location == null && !SetupChecks.hasForegroundLocation(applicationContext) ->
                RESULT_FAILED to "Izin lokasi aplikasi sudah dicabut di HP"
            location == null && !SetupChecks.isLocationServiceOn(applicationContext) ->
                RESULT_FAILED to "Lokasi (GPS) HP sedang dimatikan pemegang HP"
            location == null ->
                RESULT_FAILED to "Belum ada posisi: GPS & jaringan tidak memberi lokasi dalam ${LOCATE_TIMEOUT_MS / 1000} detik"
            fresh != null ->
                RESULT_EXECUTED to "Lokasi baru terkirim (${describe(location)})"
            else ->
                RESULT_EXECUTED to "GPS belum dapat posisi baru; dikirim posisi terakhir (${describe(location)}, " +
                    "${ageText(location)})"
        }
    }

    private fun describe(location: Location): String {
        val provider = when (location.provider) {
            "gps" -> "GPS"
            "network" -> "jaringan"
            "fused" -> "gabungan"
            else -> location.provider ?: "?"
        }
        return if (location.hasAccuracy()) "$provider, akurasi ±${location.accuracy.roundToInt()} m" else provider
    }

    private fun ageText(location: Location): String {
        val minutes = ((System.currentTimeMillis() - location.time) / 60_000L).coerceAtLeast(0)
        return when {
            minutes < 1 -> "kurang dari 1 menit lalu"
            minutes < 60 -> "$minutes menit lalu"
            else -> "${minutes / 60} jam lalu"
        }
    }

    // ---- Lock jarak jauh (anti-skip, dengan self-unlock OTP) ----

    /** Pasang LockActivity (screen pinning) + mulai watchdog pasang-ulang. Main thread. */
    private fun enforceLockAndWatch(reason: String?) {
        updateNotification(
            "Terkunci — segera kembali ke lokasi Anda" +
                (reason?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""),
        )
        try {
            LockActivity.launch(applicationContext, reason)
        } catch (_: Exception) {
            // JANGAN panggil lockNow() rutin: mematikan layar seperti tombol power, dan bersama
            // LockActivity (yang menyalakan layar lagi) menyebabkan layar hidup-mati berulang.
            // Hanya dipakai di sini, saat activity benar-benar gagal dibuka.
            val ok = TrackerDeviceAdminReceiver.lockNow(applicationContext)
            Log.i(TAG, "LockActivity gagal dibuka, fallback lockNow -> $ok")
        }
        lockWatchdogHandler.removeCallbacks(lockWatchdogRunnable)
        lockWatchdogHandler.postDelayed(lockWatchdogRunnable, LOCK_WATCHDOG_MS)
    }

    // ---- Heartbeat & detail perangkat ----

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = serviceScope.launch {
            while (true) {
                sendHeartbeatOnce()
                delay(HEARTBEAT_INTERVAL_MS)
            }
        }
    }

    private fun startDeviceInfoLoop() {
        deviceInfoJob?.cancel()
        deviceInfoJob = serviceScope.launch {
            while (true) {
                socketClient?.sendDeviceInfo(DeviceInfoCollector.collect(applicationContext))
                delay(DEVICE_INFO_INTERVAL_MS)
            }
        }
    }

    private fun sendHeartbeatOnce(location: Location? = locationTracker.current()) {
        val bleReading = bleScanner.latestReading()
        val nearbyBeacon = bleScanner.strongestOtherReading(currentAnchorUuid)
        socketClient?.sendLocation(
            source = if (bleReading != null) "ble" else "gps",
            latitude = location?.latitude,
            longitude = location?.longitude,
            bleDistanceMeters = bleReading?.second,
            bleRssi = bleReading?.first,
            batteryLevel = currentBatteryLevel(),
            ssid = currentSsid(),
            ip = null,
            nearbyBeaconUuid = nearbyBeacon?.first,
            nearbyBeaconDistanceMeters = nearbyBeacon?.third,
            accuracyMeters = location?.takeIf { it.hasAccuracy() }?.accuracy,
            provider = location?.provider,
            fixTime = location?.time,
        )
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
        // minSdk 26: channel notifikasi selalu tersedia.
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_tracking),
            NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(status: String): Notification {
        val tapIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(this, 0, tapIntent, PendingIntent.FLAG_IMMUTABLE)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_tracking_title))
            .setContentText(status)
            .setStyle(
                NotificationCompat.BigTextStyle().bigText(
                    "$status\n${getString(R.string.notification_tracking_text)}",
                ),
            )
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(pendingIntent)
            .build()
    }

    private fun updateNotification(status: String, connected: Boolean? = null) {
        TrackerStatus.update(status, connected)
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(status))
    }

    companion object {
        private const val CHANNEL_ID = "tracker_active"
        private const val NOTIFICATION_ID = 1001
        // 15 detik (dulu 30) -- auto-unlock butuh beberapa heartbeat berturut
        // yang semuanya aman (lihat UNLOCK_SAFE_STREAK_REQUIRED di
        // GeofenceEvaluator.ts); dengan heartbeat 30 detik, waktu tunggu
        // unlock setelah benar-benar kembali bisa sampai ~90 detik, terasa
        // "macet"/tidak pernah terbuka buat user yang menunggu di depan HP --
        // 15 detik memangkas itu jadi ~30 detik tanpa mengorbankan konfirmasi
        // berulang (masih bukan auto-unlock dari satu bacaan saja).
        private const val HEARTBEAT_INTERVAL_MS = 15_000L

        /** Detail perangkat (baterai/cas, jaringan, penyimpanan, izin) dikirim tiap 5 menit. */
        private const val DEVICE_INFO_INTERVAL_MS = 5 * 60_000L

        /** Batas tunggu fix GPS baru untuk perintah locate_now. */
        private const val LOCATE_TIMEOUT_MS = 30_000L

        /** Batas tunggu konfirmasi LockActivity tampil sebelum melapor hasil lock. */
        private const val LOCK_CONFIRM_TIMEOUT_MS = 6_000L

        /**
         * Jeda minimum antar laporan cepat dari perubahan zona BLE. Melindungi
         * dari noise RSSI yang bolak-balik di ambang (bisa berpuluh kali per
         * menit) supaya tidak membanjiri server tanpa mengorbankan deteksi
         * keluar/masuk radius yang nyaris real-time.
         */
        private const val BIAS_REPORT_MIN_INTERVAL_MS = 3_000L

        private const val TAG = "TrackerLock"
        private const val LOCK_WATCHDOG_MS = 5_000L

        /** Jeda klaim ulang saat device belum didaftarkan/dibuka pendaftarannya oleh admin. */
        private const val ENROLLMENT_RETRY_MS = 30_000L

        /** Jeda sambung ulang setelah gateway gagal memproses autentikasi (gangguan server). */
        private const val AUTH_RETRY_MS = 15_000L

        // Harus sama dengan CommandLifecycle.transitionFromReport di realtime-gateway.
        private const val RESULT_RECEIVED = "received"
        private const val RESULT_EXECUTED = "executed"
        private const val RESULT_FAILED = "failed"

        /** Aksi start service dari LockDefenseReceiver: pasang ulang LockActivity. */
        const val ACTION_ENSURE_LOCKED = "com.lacaksmb.tracker.action.ENSURE_LOCKED"

        fun start(context: Context) {
            val intent = Intent(context, TrackerForegroundService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }

        /**
         * Mulai service tanpa pernah meng-crash pemanggil (receiver boot, WorkManager, layar app).
         * Tanpa izin lokasi service bertipe lokasi tidak boleh jalan; Android 12+ juga bisa menolak
         * start dari latar belakang (ForegroundServiceStartNotAllowedException, turunan
         * IllegalStateException) -- dicoba lagi oleh watchdog WorkManager berikutnya.
         */
        fun startSafely(context: Context): Boolean {
            if (!SetupChecks.hasForegroundLocation(context)) {
                TrackerStatus.update("Izin lokasi belum diberikan", isConnected = false)
                return false
            }
            return try {
                start(context)
                true
            } catch (e: IllegalStateException) {
                Log.w(TAG, "service belum boleh dimulai dari latar belakang: ${e.message}")
                false
            } catch (e: SecurityException) {
                Log.w(TAG, "service ditolak sistem: ${e.message}")
                false
            }
        }
    }
}
