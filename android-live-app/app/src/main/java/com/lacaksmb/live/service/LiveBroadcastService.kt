package com.lacaksmb.live.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.Manifest
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.lacaksmb.live.data.ApiClient
import com.lacaksmb.live.data.ApiResult
import com.lacaksmb.live.data.SessionStore
import com.lacaksmb.live.ui.MainActivity
import io.livekit.android.AudioOptions
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.events.DisconnectReason
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.LocalTrackPublication
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.ScreenSharePresets
import io.livekit.android.room.track.VideoPreset169
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import livekit.org.webrtc.VideoSink
import java.util.concurrent.atomic.AtomicLong

/**
 * Live Kerja dari HP: menyiarkan layar HP + kamera depan + mikrofon ke atasan
 * lewat LiveKit, TETAP JALAN saat staf pindah aplikasi atau layar mati -- hal yang
 * tidak bisa dilakukan dashboard web/PWA (browser HP menghentikan kamera
 * begitu halaman masuk latar belakang).
 *
 * Kuncinya foreground service bertipe `camera` (+ `microphone` kalau izin
 * mikrofon diberikan) yang dimulai dari tombol Mulai kerja (app sedang
 * terlihat): selama service ini hidup, Android mengizinkan app memakai
 * kamera & mikrofon walau Activity-nya sudah di latar belakang.
 *
 * Layar dibagikan lewat MediaProjection: izinnya diminta Activity tepat
 * sebelum Mulai kerja (atau tombol Bagikan layar), hasilnya dikirim ke sini
 * dan dipakai SEKALI (Android 14+ melarang memakai ulang izin yang sama).
 * LiveKit menjalankan foreground service mediaProjection-nya sendiri.
 *
 * Perilaku dicocokkan dengan web-dashboard/src/stores/live.js: kamera +
 * mikrofon (bisa dibisukan staf, pilihan bisu diingat), 720p + simulcast
 * h180/h360, layar 1080p 15fps + simulcast, dynacast, tidak berlangganan
 * video peserta lain, heartbeat tiap 30 detik (+ langsung saat layar/kamera
 * berubah) berisi camera_active & screen_active, dan 404 dari heartbeat =
 * server sudah menutup sesi -> berhenti.
 */
class LiveBroadcastService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var sessionStore: SessionStore
    private lateinit var apiClient: ApiClient

    private var runJob: Job? = null
    private var room: Room? = null
    private var userStopped = false
    private var finished = false

    // Hasil izin MediaProjection dari Activity, menunggu room tersambung.
    // Sekali pakai: setelah dipakai (berhasil atau gagal) dibuang.
    private var pendingScreenData: Intent? = null

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    // Jumlah frame kamera yang benar-benar keluar dari kamera -- dipakai
    // watchdog untuk tahu kamera macet (mis. direbut aplikasi kamera lain)
    // walau track LiveKit-nya masih tercatat "terbit".
    private val frameCount = AtomicLong(0)
    private val frameCounter = VideoSink { frameCount.incrementAndGet() }
    private var watchedTrack: LocalVideoTrack? = null

    override fun onCreate() {
        super.onCreate()
        sessionStore = SessionStore(applicationContext)
        apiClient = ApiClient(sessionStore)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopBroadcast(userInitiated = true, error = null)
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_SHARE_SCREEN) {
            // Bagikan layar lagi di tengah siaran (izin baru dari Activity).
            val data = screenDataOf(intent) ?: return START_NOT_STICKY
            val current = room
            if (runJob?.isActive == true && current != null) {
                scope.launch { shareScreen(current, data) }
            } else if (runJob?.isActive == true) {
                pendingScreenData = data
            }
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_SET_MIC) {
            // Hanya berlaku untuk siaran yang sedang jalan -- service tidak
            // boleh dihidupkan oleh tombol mikrofon saja.
            if (runJob?.isActive == true) setMicMuted(intent.getBooleanExtra(EXTRA_MUTED, false))
            return START_NOT_STICKY
        }

        // startForeground wajib dipanggil cepat setelah startForegroundService.
        // Android 14+ melempar SecurityException kalau izin kamera belum
        // diberikan -- LiveScreen sudah memintanya, ini jaga-jaga saja.
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                buildNotification("Menyambungkan siaran..."),
                foregroundServiceType(),
            )
        } catch (e: SecurityException) {
            LiveBroadcastState.setStatus(BroadcastStatus.Idle("Izin kamera belum diberikan ke aplikasi ini"))
            stopSelf()
            return START_NOT_STICKY
        }

        screenDataOf(intent)?.let { pendingScreenData = it }

        if (runJob?.isActive != true) {
            userStopped = false
            finished = false
            acquireLocks()
            runJob = scope.launch { runBroadcast() }
        }

        // NOT_STICKY: kalau proses dimatikan sistem, service yang dihidupkan
        // ulang dari latar belakang tidak diizinkan membuka kamera lagi
        // (Android 11+). Sesi di server ditutup sendiri oleh timeout heartbeat.
        return START_NOT_STICKY
    }

    private suspend fun runBroadcast() {
        var everLive = false
        var retry = 0

        while (scope.isActive && !userStopped) {
            LiveBroadcastState.setStatus(
                BroadcastStatus.Connecting(if (everLive) "Koneksi terputus, menyambung ulang..." else "Menyambungkan siaran..."),
            )
            updateNotification(if (everLive) "Koneksi terputus, menyambung ulang..." else "Menyambungkan siaran...")

            // /start juga dipakai saat menyambung ulang: sesi yang masih
            // terbuka dilanjutkan dan token LiveKit baru diterbitkan.
            when (val result = apiClient.startLiveSession()) {
                is ApiResult.Fail -> {
                    val fatal = !everLive || result.httpCode in listOf(401, 403, 422)
                    if (fatal) {
                        stopBroadcast(userInitiated = false, error = describeStartFailure(result))
                        return
                    }
                }
                is ApiResult.Ok -> {
                    val data = result.data
                    val url = data?.optString("livekit_url").orEmpty()
                    val token = data?.optString("token").orEmpty()
                    if (url.isBlank() || token.isBlank()) {
                        stopBroadcast(userInitiated = false, error = "Respons server tidak lengkap (alamat/token LiveKit kosong)")
                        return
                    }

                    val reason = try {
                        broadcastUntilDisconnected(url, token) { everLive = true; retry = 0 }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        if (!everLive) {
                            stopBroadcast(userInitiated = false, error = describeConnectFailure(e))
                            return
                        }
                        null
                    }

                    if (userStopped) return
                    when (reason) {
                        DisconnectReason.DUPLICATE_IDENTITY -> {
                            stopBroadcast(userInitiated = false, error = "Siaran diambil alih oleh perangkat lain yang login dengan akun yang sama")
                            return
                        }
                        DisconnectReason.PARTICIPANT_REMOVED,
                        DisconnectReason.ROOM_DELETED,
                        DisconnectReason.ROOM_CLOSED -> {
                            stopBroadcast(userInitiated = false, error = "Sesi kerja sudah ditutup dari server")
                            return
                        }
                        else -> Unit // jaringan putus -- coba sambung ulang
                    }
                }
            }

            // Backoff 2, 4, 8, 15, 15, ... detik selama staf belum menekan Selesai kerja.
            delay(minOf(2_000L shl minOf(retry, 3), 15_000L))
            retry++
        }
    }

    /**
     * Sambung ke room, nyalakan kamera, lalu tunggu sampai room terputus.
     * [onLive] dipanggil sekali setelah kamera benar-benar terbit.
     */
    private suspend fun broadcastUntilDisconnected(url: String, token: String, onLive: () -> Unit): DisconnectReason {
        val newRoom = LiveKit.create(
            applicationContext,
            RoomOptions(
                // Tidak menonton siapa pun dari HP -- adaptiveStream tidak relevan.
                adaptiveStream = false,
                // dynacast: berhenti meng-encode layer yang tidak diminta
                // penonton -- hemat baterai & kuota selama berjam-jam.
                dynacast = true,
                videoTrackCaptureDefaults = LocalVideoTrackOptions(
                    position = CameraPosition.FRONT,
                    captureParams = VideoPreset169.H720.capture,
                ),
                videoTrackPublishDefaults = VideoTrackPublishDefaults(
                    videoEncoding = VideoPreset169.H720.encoding,
                    simulcast = true,
                    simulcastLayers = listOf(VideoPreset169.H180, VideoPreset169.H360),
                ),
                // Layar kerja: teks harus terbaca, gerakan tidak penting --
                // sama dengan dashboard web (1080p 15fps, lapis 360p & 720p).
                screenShareTrackCaptureDefaults = LocalVideoTrackOptions(
                    captureParams = ScreenSharePresets.H1080_FPS15.capture,
                ),
                screenShareTrackPublishDefaults = VideoTrackPublishDefaults(
                    videoEncoding = ScreenSharePresets.H1080_FPS15.encoding,
                    simulcast = true,
                    simulcastLayers = listOf(ScreenSharePresets.H360_FPS3, ScreenSharePresets.H720_FPS5),
                ),
            ),
            // NoAudioHandler: aplikasi ini hanya MENGIRIM suara, tidak memutar
            // apa pun -- jangan ambil fokus audio / ubah mode audio HP (musik
            // & telepon staf tidak terganggu). Perekaman mikrofon tetap jalan.
            LiveKitOverrides(audioOptions = AudioOptions(audioHandler = NoAudioHandler())),
        )
        room = newRoom

        // Mulai mendengarkan SEBELUM connect: event Disconnected tidak
        // di-replay, jadi putus di tengah penyiapan tidak boleh terlewat.
        val disconnectReason = CompletableDeferred<DisconnectReason>()
        val eventsJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            newRoom.events.events.collect { event ->
                when (event) {
                    is RoomEvent.Disconnected -> disconnectReason.complete(event.reason)
                    is RoomEvent.Reconnecting -> updateNotification("Koneksi tersendat, menyambung ulang...")
                    is RoomEvent.Reconnected -> updateNotification(liveNotificationText())
                    else -> Unit
                }
            }
        }
        var heartbeat: Job? = null
        var watchdog: Job? = null

        try {
            newRoom.connect(url, token, ConnectOptions(autoSubscribe = false))
            if (!newRoom.localParticipant.setCameraEnabled(true)) {
                throw IllegalStateException("Kamera tidak bisa dinyalakan")
            }
            attachFrameCounter(newRoom)
            LiveBroadcastState.setRoom(newRoom)
            publishMicrophone(newRoom)
            pendingScreenData?.let { data ->
                pendingScreenData = null
                shareScreen(newRoom, data)
            }
            LiveBroadcastState.setStatus(BroadcastStatus.Live)
            updateNotification(liveNotificationText())
            onLive()
            reportStateNow()

            heartbeat = scope.launch { heartbeatLoop() }
            watchdog = scope.launch { cameraWatchdog(newRoom) }
            return disconnectReason.await()
        } finally {
            eventsJob.cancel()
            heartbeat?.cancel()
            watchdog?.cancel()
            withContext(NonCancellable) { releaseRoom() }
        }
    }

    private suspend fun heartbeatLoop() {
        while (scope.isActive) {
            delay(HEARTBEAT_INTERVAL_MS)
            val result = sendHeartbeat()
            if (result is ApiResult.Fail) {
                when (result.httpCode) {
                    404 -> { stopBroadcast(userInitiated = false, error = "Sesi kerja sudah ditutup server (koneksi sempat terputus terlalu lama)", endSession = false); return }
                    401 -> { stopBroadcast(userInitiated = false, error = "Sesi login berakhir — keluar lalu masuk lagi", endSession = false); return }
                    // Gagal jaringan sesaat: abaikan, coba lagi di detak berikutnya.
                }
            }
        }
    }

    /**
     * Kamera bisa berhenti tanpa memutus room (aplikasi kamera lain dibuka,
     * HP mencabut akses sebentar). Kalau tidak ada frame baru sejak cek
     * sebelumnya, matikan-nyalakan ulang kamera -- foreground service tipe
     * camera membuat ini tetap diizinkan dari latar belakang.
     */
    private suspend fun cameraWatchdog(room: Room) {
        var lastCount = frameCount.get()
        while (scope.isActive) {
            delay(CAMERA_WATCHDOG_MS)
            val now = frameCount.get()
            if (now == lastCount && room.state == Room.State.CONNECTED && !userStopped) {
                updateNotification("Kamera berhenti, menyalakan ulang...")
                try {
                    room.localParticipant.setCameraEnabled(false)
                    room.localParticipant.setCameraEnabled(true)
                    attachFrameCounter(room)
                    updateNotification(liveNotificationText())
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    updateNotification("Kamera sedang dipakai aplikasi lain, mencoba lagi...")
                }
            }
            lastCount = frameCount.get()
        }
    }

    private suspend fun sendHeartbeat(): ApiResult {
        val camera = (room?.localParticipant?.getTrackPublication(Track.Source.CAMERA))?.let { !it.muted } ?: false
        return apiClient.heartbeatLiveSession(cameraActive = camera, screenActive = LiveBroadcastState.screenSharing.value)
    }

    /** Detak tambahan begitu layar/kamera berubah -- penonton tidak menunggu 30 detik. */
    private fun reportStateNow() {
        if (room == null || finished) return
        scope.launch { sendHeartbeat() }
    }

    /**
     * Bagikan layar HP memakai izin MediaProjection [data] (sekali pakai).
     * Berhenti sendiri (staf menekan "Berhenti berbagi" dari sistem, layar
     * dikunci di beberapa HP, dll.) = dilaporkan Screen off ke server dan
     * staf diminta membagikan lagi dari aplikasi.
     */
    private suspend fun shareScreen(room: Room, data: Intent) {
        try {
            val params = ScreenCaptureParams(
                data,
                SCREEN_NOTIFICATION_ID,
                buildScreenNotification(),
            ) { scope.launch { onScreenShareStopped() } }
            val shared = room.localParticipant.setScreenShareEnabled(true, params)
            LiveBroadcastState.setScreenSharing(shared)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            LiveBroadcastState.setScreenSharing(false)
        }
        updateNotification(liveNotificationText())
        reportStateNow()
    }

    private fun onScreenShareStopped() {
        if (!LiveBroadcastState.screenSharing.value) return
        LiveBroadcastState.setScreenSharing(false)
        updateNotification(liveNotificationText())
        reportStateNow()
    }

    private fun hasMicPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    // Tipe microphone hanya kalau izinnya ada -- Android 14+ melempar
    // SecurityException untuk tipe FGS yang izinnya belum diberikan.
    private fun foregroundServiceType(): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return 0
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        if (hasMicPermission()) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        return type
    }

    private fun micMutedPref(): Boolean =
        getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(PREF_MIC_MUTED, false)

    /**
     * Terbitkan mikrofon sesuai pilihan bisu staf. Track dimatikan SEBELUM
     * diterbitkan kalau staf memilih bisu, jadi suaranya tidak pernah
     * tersiar sesaat pun. Gagal = siaran kamera tetap jalan tanpa suara.
     */
    private suspend fun publishMicrophone(room: Room) {
        if (!hasMicPermission()) {
            LiveBroadcastState.setMicState(MicState.None)
            return
        }
        val muted = micMutedPref()
        try {
            val track = room.localParticipant.createAudioTrack()
            track.enabled = !muted
            room.localParticipant.publishAudioTrack(track)
            if (muted) localMicPublication(room)?.muted = true
            LiveBroadcastState.setMicState(if (muted) MicState.Muted else MicState.On)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            LiveBroadcastState.setMicState(MicState.None)
        }
    }

    private fun localMicPublication(room: Room): LocalTrackPublication? =
        room.localParticipant.getTrackPublication(Track.Source.MICROPHONE) as? LocalTrackPublication

    /** Bisukan / nyalakan mikrofon tanpa memutus siaran; pilihan diingat untuk siaran berikutnya. */
    private fun setMicMuted(muted: Boolean) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(PREF_MIC_MUTED, muted).apply()
        val current = room ?: return
        scope.launch {
            val publication = localMicPublication(current)
            if (publication == null) {
                if (!muted) publishMicrophone(current)
            } else {
                publication.muted = muted
                LiveBroadcastState.setMicState(if (muted) MicState.Muted else MicState.On)
            }
            updateNotification(liveNotificationText())
        }
    }

    private fun liveNotificationText(): String {
        if (!LiveBroadcastState.screenSharing.value) {
            return "Layar belum dibagikan — tidak dihitung kerja. Buka aplikasi lalu Bagikan layar."
        }
        return when (LiveBroadcastState.micState.value) {
            MicState.On -> "Layar, kamera & suara disiarkan ke atasan"
            MicState.Muted -> "Layar & kamera disiarkan · mikrofon dibisukan"
            MicState.None -> "Layar & kamera disiarkan ke atasan (tanpa suara)"
        }
    }

    private fun buildScreenNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Layar sedang dibagikan")
            .setContentText("Layar HP disiarkan ke atasan selama Live Kerja")
            .setSmallIcon(android.R.drawable.ic_menu_slideshow)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

    private fun attachFrameCounter(room: Room) {
        val track = room.localParticipant.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack
        if (track === watchedTrack) return
        watchedTrack?.removeRenderer(frameCounter)
        track?.addRenderer(frameCounter)
        watchedTrack = track
    }

    private suspend fun releaseRoom() {
        val current = room ?: return
        room = null
        watchedTrack?.removeRenderer(frameCounter)
        watchedTrack = null
        // Lepas dari layar dulu supaya pratinjau melepas renderer-nya
        // sebelum Room (dan EGL context-nya) dibebaskan.
        LiveBroadcastState.setRoom(null)
        delay(150)
        current.disconnect()
        current.release()
    }

    /**
     * Akhiri siaran. [endSession] false bila server sudah menutup sesinya
     * sendiri (heartbeat 404/401) -- tidak perlu memanggil /end lagi.
     */
    private fun stopBroadcast(userInitiated: Boolean, error: String?, endSession: Boolean = true) {
        if (finished) return
        finished = true
        userStopped = true
        LiveBroadcastState.setStatus(BroadcastStatus.Stopping)
        updateNotification("Menghentikan siaran...")

        val job = runJob
        scope.launch {
            withContext(NonCancellable) {
                job?.cancel()
                releaseRoom()
                if (endSession) {
                    // 404 = sesi memang sudah tidak ada; selain itu, kalau gagal
                    // jaringan, timeout heartbeat server yang akan menutupnya.
                    apiClient.endLiveSession()
                }
                LiveBroadcastState.setStatus(BroadcastStatus.Idle(if (userInitiated) null else error))
                releaseLocks()
                ServiceCompat.stopForeground(this@LiveBroadcastService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
    }

    override fun onDestroy() {
        if (!finished) {
            // Dihentikan tanpa lewat stopBroadcast (mis. dimatikan dari
            // pengaturan sistem): bereskan room & beri tahu server sebisanya.
            finished = true
            room?.let { it.disconnect(); it.release() }
            room = null
            LiveBroadcastState.setRoom(null)
            LiveBroadcastState.setStatus(BroadcastStatus.Idle("Siaran dihentikan oleh sistem"))
            val api = apiClient
            Thread { runBlocking { api.endLiveSession() } }.start()
            releaseLocks()
        }
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // CPU & Wi-Fi tetap hidup saat layar mati -- tanpa ini encoder video
    // ikut tertidur dan siaran membeku walau service masih berjalan.
    @Suppress("DEPRECATION")
    private fun acquireLocks() {
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LacakLive:broadcast")
                .apply { setReferenceCounted(false); acquire() }
        }
        if (wifiLock == null) {
            wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "LacakLive:broadcast")
                .apply { setReferenceCounted(false); acquire() }
        }
    }

    private fun releaseLocks() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
        wifiLock?.takeIf { it.isHeld }?.release()
        wifiLock = null
    }

    private fun describeStartFailure(result: ApiResult.Fail): String = when (result.httpCode) {
        401 -> "Sesi login berakhir — keluar lalu masuk lagi"
        403 -> "Akun ini tidak punya izin menyiarkan Live Kerja"
        else -> result.message
    }

    private fun describeConnectFailure(e: Exception): String {
        val detail = e.message?.takeIf { it.isNotBlank() }
        return if (detail != null && detail.contains("Kamera")) {
            "$detail. Tutup aplikasi lain yang memakai kamera, lalu coba lagi."
        } else {
            "Gagal tersambung ke server siaran" + (detail?.let { " ($it)" } ?: "")
        }
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(CHANNEL_ID, "Siaran Live Kerja", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Tampil selama layar & kamera sedang disiarkan ke atasan"
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(status: String): Notification {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, LiveBroadcastService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Sedang menyiarkan")
            .setContentText(status)
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openApp)

        // Tombol mikrofon langsung di notifikasi -- staf bisa membisukan diri
        // tanpa membuka aplikasi (mis. saat menerima telepon pribadi).
        val mic = LiveBroadcastState.micState.value
        if (room != null && mic != MicState.None) {
            val muteNext = mic == MicState.On
            val toggleMic = PendingIntent.getService(
                this,
                2,
                Intent(this, LiveBroadcastService::class.java).setAction(ACTION_SET_MIC).putExtra(EXTRA_MUTED, muteNext),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            builder.addAction(0, if (muteNext) "Bisukan" else "Nyalakan mikrofon", toggleMic)
        }

        return builder.addAction(0, "Selesai kerja", stop).build()
    }

    private fun updateNotification(status: String) {
        if (finished && status != "Menghentikan siaran...") return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(status))
    }

    companion object {
        private const val CHANNEL_ID = "live_broadcast"
        private const val NOTIFICATION_ID = 3001
        private const val ACTION_START = "com.lacaksmb.live.action.START"
        private const val ACTION_STOP = "com.lacaksmb.live.action.STOP"
        private const val ACTION_SET_MIC = "com.lacaksmb.live.action.SET_MIC"
        private const val ACTION_SHARE_SCREEN = "com.lacaksmb.live.action.SHARE_SCREEN"
        private const val EXTRA_SCREEN_DATA = "screen_data"
        private const val SCREEN_NOTIFICATION_ID = 3002
        private const val EXTRA_MUTED = "muted"
        private const val PREFS = "live_broadcast"
        private const val PREF_MIC_MUTED = "mic_muted"
        private const val HEARTBEAT_INTERVAL_MS = 30_000L
        private const val CAMERA_WATCHDOG_MS = 10_000L

        /**
         * Harus dipanggil saat app terlihat -- Android melarang FGS kamera dimulai
         * dari latar belakang. [screenData] = hasil izin MediaProjection (null =
         * siaran tanpa layar, tercatat Screen off sampai staf membagikannya).
         */
        fun start(context: Context, screenData: Intent?) {
            val intent = Intent(context, LiveBroadcastService::class.java).setAction(ACTION_START)
            screenData?.let { intent.putExtra(EXTRA_SCREEN_DATA, it) }
            ContextCompat.startForegroundService(context, intent)
        }

        /** Bagikan layar lagi di tengah siaran (izin MediaProjection baru). */
        fun shareScreen(context: Context, screenData: Intent) {
            context.startService(
                Intent(context, LiveBroadcastService::class.java)
                    .setAction(ACTION_SHARE_SCREEN)
                    .putExtra(EXTRA_SCREEN_DATA, screenData),
            )
        }

        @Suppress("DEPRECATION")
        private fun screenDataOf(intent: Intent?): Intent? = when {
            intent == null -> null
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> intent.getParcelableExtra(EXTRA_SCREEN_DATA, Intent::class.java)
            else -> intent.getParcelableExtra(EXTRA_SCREEN_DATA)
        }

        /** Bisukan / nyalakan mikrofon siaran yang sedang jalan. */
        fun setMicMuted(context: Context, muted: Boolean) {
            context.startService(
                Intent(context, LiveBroadcastService::class.java).setAction(ACTION_SET_MIC).putExtra(EXTRA_MUTED, muted),
            )
        }

        fun stop(context: Context) {
            // Lewat startService (bukan stopService) supaya /end sempat dipanggil
            // dan Room diputus rapi sebelum service berhenti.
            context.startService(Intent(context, LiveBroadcastService::class.java).setAction(ACTION_STOP))
        }
    }
}
