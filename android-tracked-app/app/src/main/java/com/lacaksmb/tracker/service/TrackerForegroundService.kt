package com.lacaksmb.tracker.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.lacaksmb.tracker.BuildConfig
import com.lacaksmb.tracker.R
import com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver
import com.lacaksmb.tracker.data.DeviceIdentityStore
import com.lacaksmb.tracker.data.DeviceLockStore
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
 *  - Menjalankan perintah 'lock' lewat Device Admin — kunci disimpan PERSISTEN,
 *    lapisan peringatan layar penuh dipasang, dan LockDefenseReceiver mengunci
 *    ulang saat user mencoba membuka paksa (tidak bisa di-skip)
 *  - Heartbeat tiap 30 detik berisi posisi GPS + level baterai + SSID WiFi
 *    (terpasang, bukan null) supaya radar dashboard & geofence WiFi/IP
 *    benar-benar berfungsi
 */
class TrackerForegroundService : Service(), GatewaySocketClient.Listener {

    private lateinit var identityStore: DeviceIdentityStore
    private lateinit var lockStore: DeviceLockStore
    private var socketClient: GatewaySocketClient? = null

    // Lapisan peringatan layar penuh saat perangkat dikunci admin
    // (SYSTEM_ALERT_WINDOW). Di-remove saat unlock / service berhenti.
    private var lockedOverlayView: View? = null

    // Kunci ulang TERTUNDA: setelah lapisan peringatan tampil (user melihat
    // peringatan), layar dikunci lagi ~10 detik kemudian supaya device tidak
    // bisa dipakai berlama-lama. Di-cancel saat unlock.
    private val lockReapplyHandler = Handler(Looper.getMainLooper())
    private val lockReapplyRunnable = Runnable {
        serviceScope.launch {
            val lock = lockStore.snapshot()
            if (lock.adminLocked) {
                Log.i(TAG, "Kunci ulang tertunda: perangkat masih locked, lockNow")
                enforceLockNow()
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

    override fun onCreate() {
        super.onCreate()
        identityStore = DeviceIdentityStore(applicationContext)
        lockStore = DeviceLockStore(applicationContext)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification(status = "Menghubungkan..."))

        // Dipanggil LockDefenseReceiver saat keyguard dilewati user padahal
        // status masih locked: pasang ulang lapisan peringatan + jadwalkan
        // kunci ulang (tanpa mematikan layar dulu supaya peringatan terlihat).
        if (intent?.action == ACTION_ENSURE_LOCKED_OVERLAY) {
            serviceScope.launch {
                val lock = lockStore.snapshot()
                if (lock.adminLocked) {
                    ensureLockUiWithSchedule(lock.reason)
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
            )

            // Terapkan ulang status kunci kalau device sedang dikunci admin —
            // berlaku setelah reboot / service di-restart sistem (mis. user
            // mencoba "menghidupkan ulang" sebagai cara menyingkirkan kunci).
            val lock = lockStore.snapshot()
            if (lock.adminLocked) {
                ensureLockUiWithSchedule(lock.reason)
                enforceLockNow()
            }
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
        removeLockedOverlay()
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
                // Kunci dapat di-ABA yang (hanya lockNow() sekali) — sekarang
                // disimpan PERSISTEN + lapisan peringatan layar penuh muncul +
                // kunci ulang tertunda menjaganya: user melihat peringatan
                // "PERANGKAT DIKUNCI" dan tetap tidak bisa memakai device.
                serviceScope.launch {
                    lockStore.setLocked(reasonNote)
                    enforceLockNow()
                    ensureLockUiWithSchedule(reasonNote)
                }
            }
            "unlock" -> {
                // Membuka kunci layar tidak bisa diprogram langsung (dilarang
                // sistem Android, hanya lockNow() yang diizinkan Device Admin).
                // "Unlock" di sini = cabut status kunci admin + lepas lapisan
                // peringatan; user membuka keyguard dengan pola/PIN/swipe biasa.
                serviceScope.launch {
                    lockStore.clear()
                    removeLockedOverlay()
                    updateNotification("Perintah unlock diterima — perangkat bisa dipakai")
                }
            }
            "locate_now" -> {
                serviceScope.launch { sendHeartbeatOnce() }
            }
        }
        commandId?.let { socketClient?.acknowledgeCommand(it) }
    }

    // ---- Lock jarak jauh (anti-skip) ----

    /** Kunci layar SEKARANG via Device Admin. */
    private fun enforceLockNow() {
        val ok = TrackerDeviceAdminReceiver.lockNow(applicationContext)
        Log.i(TAG, "enforceLockNow -> $ok")
    }

    /**
     * Tampilkan peringatan + pasang penegakan: notifikasi 🔒, lapisan layar
     * penuh, lalu jadwalkan kunci ulang ~10 detik kemudian. Dipanggil saat
     * perintah lock diterima, saat keyguard dilewati user padahal status
     * masih locked, dan saat service di-restart dalam keadaan locked.
     */
    private fun ensureLockUiWithSchedule(reason: String?) {
        ContextCompat.getMainExecutor(this).execute {
            val overlayGranted = Settings.canDrawOverlays(applicationContext)
            Log.i(TAG, "ensureLockUiWithSchedule reason=${reason.orEmpty()} overlayGranted=$overlayGranted")

            updateNotification(
                "🔒 DIKUNCI ADMIN" + (reason?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""),
            )
            if (overlayGranted) {
                if (showLockedOverlay(reason)) {
                    scheduleLockReapply()
                }
            } else {
                // Izin lapisan belum diberikan — tampilkan halaman setelannya
                // supaya user paham kenapa, dan kunci tetap dijaga lockNow.
                try {
                    val intent = Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:$packageName"),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(intent)
                } catch (_: Exception) {
                    // Best-effort: penegakan lockNow tetap berjalan.
                }
            }
        }
    }

    private fun scheduleLockReapply() {
        lockReapplyHandler.removeCallbacks(lockReapplyRunnable)
        lockReapplyHandler.postDelayed(lockReapplyRunnable, LOCK_REAPPLY_MS)
    }

    /**
     * Lapisan full-screen gelap dengan peringatan lock. Bukan widget yang bisa
     * ditutup — pengguna tidak punya tombol apa pun di atasnya; layar hanya
     * bisa dipakai lagi setelah status unlock dari server. Mengembalikan true
     * kalau berhasil tampil, false kalau tidak (penegakan lockNow tetap jalan).
     */
    private fun showLockedOverlay(reason: String?): Boolean {
        if (lockedOverlayView != null) return true // sudah tampil

        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        val density = resources.displayMetrics.density
        val dp = { value: Int -> (value * density).toInt() }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xE6000000.toInt())
            setPadding(dp(32), dp(24), dp(32), dp(24))
        }

        fun textView(
            text: String,
            size: Float,
            color: Int,
            bold: Boolean = false,
        ) = TextView(this).apply {
            this.text = text
            this.textSize = size
            if (bold) typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(color)
            gravity = Gravity.CENTER
        }

        val lockIcon = textView("\uD83D\uDD12", 64f, android.graphics.Color.WHITE)
        val lockTitle = textView("PERANGKAT DIKUNCI", 24f, android.graphics.Color.WHITE, bold = true)
        val lockReason = textView(
            reason?.takeIf { it.isNotBlank() }?.let { "Alasan: $it" } ?: "Dikunci oleh admin Lacak SMB",
            16f,
            0xFFEF5350.toInt(),
            bold = true,
        )
        val lockSub = textView(
            "Perangkat ini dikunci jarak jauh melalui Lacak SMB.\n" +
                "Anda tidak dapat memakai perangkat sampai admin\n" +
                "membuka kunci dari dashboard / aplikasi master.",
            14f,
            android.graphics.Color.LTGRAY,
        )

        fun margins(top: Int) = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(top) }

        root.addView(lockIcon)
        root.addView(lockTitle, margins(12))
        root.addView(lockReason, margins(16))
        root.addView(lockSub, margins(24))

        val flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            flags,
            PixelFormat.OPAQUE,
        )
        params.gravity = Gravity.TOP or Gravity.START
        params.x = 0
        params.y = 0
        params.title = "LacakSMB Locked Screen"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            params.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }

        return try {
            wm.addView(root, params)
            lockedOverlayView = root
            Log.i(TAG, "showLockedOverlay: tampil")
            true
        } catch (e: Exception) {
            // BadTokenException dll. — kunci tetap dipertahankan oleh receiver.
            Log.w(TAG, "showLockedOverlay gagal: ${e.javaClass.simpleName}: ${e.message}")
            false
        }
    }

    private fun removeLockedOverlay() {
        lockReapplyHandler.removeCallbacks(lockReapplyRunnable)
        val view = lockedOverlayView ?: return
        lockedOverlayView = null
        try {
            val wm = getSystemService(WINDOW_SERVICE) as WindowManager
            wm.removeView(view)
        } catch (_: Exception) {
            // Sudah di-remove / window manager berubah — aman diabaikan.
        }
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

        private const val TAG = "TrackerLock"
        private const val LOCK_REAPPLY_MS = 10_000L

        /** Aksi start service dari LockDefenseReceiver: pasang ulang lapisan peringatan. */
        const val ACTION_ENSURE_LOCKED_OVERLAY =
            "com.lacaksmb.tracker.action.ENSURE_LOCKED_OVERLAY"

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
