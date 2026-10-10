package com.lacaksmb.master.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.lacaksmb.master.BuildConfig
import com.lacaksmb.master.ble.BleBeaconAdvertiser
import com.lacaksmb.master.data.SessionStore
import com.lacaksmb.master.ui.MainActivity
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import java.util.UUID

/**
 * APK Master jadi "anchor bergerak": selagi service ini hidup (dimulai saat
 * login, lihat MainActivity.onCreate & TwoFactorScreen, dihentikan saat
 * logout di DeviceListScreen), HP ini memancarkan beacon BLE berisi UUID
 * acak khusus instalasi ini -- APK Lacak yang mendeteksinya lewat BLE dalam
 * radius aman melaporkannya ke gateway, yang mencocokkan UUID itu ke sesi
 * /ops yang sedang login di sini (lihat master:beacon:start, dikirim di
 * bawah) untuk menentukan izinnya: super_admin menghitung untuk site MANA
 * PUN dalam radius, role lain cuma untuk site miliknya sendiri -- realtime-
 * gateway master_anchor_registry.ts yang menegakkan itu, BUKAN app ini.
 *
 * SENGAJA foreground service (bukan berhenti saat app ditutup/di-swipe) --
 * permintaan eksplisit: anchor harus tetap menyiarkan walau layar/app APK
 * Master ditutup, sama seperti APK Lacak selalu online. UUID beacon DIBUAT
 * SENDIRI oleh app ini (bukan dari server) -- keabsahannya datang dari sesi
 * socket /ops yang sudah login, bukan dari nilai UUID itu sendiri.
 */
class MasterAnchorService : Service() {

    private lateinit var sessionStore: SessionStore
    private val advertiser by lazy { BleBeaconAdvertiser(applicationContext) }
    private var socket: Socket? = null

    override fun onCreate() {
        super.onCreate()
        sessionStore = SessionStore(applicationContext)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification("Menghubungkan..."))

        val token = sessionStore.accessToken()
        val user = sessionStore.user()
        // Belum login, atau login tapi tidak punya izin lock/unlock sama
        // sekali (staff_viewer/admin/leader view-only) -- jangan jalan diam-
        // diam, tidak ada gunanya jadi anchor kalau memang tidak berwenang
        // membuka kunci apa pun (gateway juga menolaknya, ini cuma jaga-jaga
        // supaya baterai tidak terbuang untuk sesi yang pasti ditolak).
        if (token.isNullOrBlank() || user == null || !user.can("devices.unlock")) {
            stopSelf()
            return START_NOT_STICKY
        }

        connectAndAdvertise(token)

        // START_STICKY: konsisten dengan APK Lacak -- sistem diminta restart
        // service kalau di-kill karena tekanan memori selagi masih login.
        return START_STICKY
    }

    private fun connectAndAdvertise(token: String) {
        val beaconUuid = ensureBeaconUuid()

        val options = IO.Options.builder()
            .setTransports(arrayOf("websocket"))
            .setReconnection(true)
            .setReconnectionDelay(2000)
            .setReconnectionDelayMax(15000)
            .setAuth(mapOf("token" to token))
            .build()

        val sock = IO.socket("${BuildConfig.GATEWAY_URL}/ops", options)
        socket = sock

        sock.on(Socket.EVENT_CONNECT) {
            updateNotification("Aktif — anchor jarak dekat menyala")
            val payload = JSONObject().apply { put("beaconUuid", beaconUuid) }
            sock.emit("master:beacon:start", payload)
        }
        sock.on(Socket.EVENT_DISCONNECT) {
            updateNotification("Terputus, mencoba menyambung ulang...")
        }
        sock.on("session:expired") {
            // Token kedaluwarsa (idle timeout, lihat backend-api
            // ExtendTokenExpiry) -- hentikan diri sendiri, jangan terus
            // mencoba konek pakai token yang sudah pasti ditolak selamanya.
            stopSelf()
        }

        sock.connect()
        advertiser.start(beaconUuid)
    }

    override fun onDestroy() {
        socket?.emit("master:beacon:stop")
        socket?.disconnect()
        socket?.off()
        socket = null
        advertiser.stop()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** UUID dibuat sekali per instalasi (bukan per-login) -- disimpan di prefs biasa, bukan rahasia (sama posisinya dengan device_uuid APK Lacak). */
    private fun ensureBeaconUuid(): String {
        val prefs: SharedPreferences = applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val existing = prefs.getString(KEY_BEACON_UUID, null)
        if (!existing.isNullOrBlank()) return existing
        val generated = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_BEACON_UUID, generated).apply()
        return generated
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Anchor Master Aktif",
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
            .setContentTitle("Lacak SMB Master — Anchor")
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
        private const val CHANNEL_ID = "master_anchor_active"
        private const val NOTIFICATION_ID = 2001
        private const val PREFS_NAME = "master_anchor"
        private const val KEY_BEACON_UUID = "beacon_uuid"

        fun start(context: Context) {
            val intent = Intent(context, MasterAnchorService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, MasterAnchorService::class.java))
        }
    }
}
