package com.lacaksmb.tracker.service

import android.util.Log
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject

/**
 * Pembungkus tipis socket.io-client untuk namespace /device milik
 * realtime-gateway (lihat realtime-gateway/start/socket.ts). Satu instance
 * dipakai sepanjang hidup TrackerForegroundService.
 */
class GatewaySocketClient(
    private val gatewayBaseUrl: String,
    private val listener: Listener,
) {
    interface Listener {
        /** bleAnchorUuid non-null kalau site ini pakai mode geofence BLE -- lihat BleBeaconScanner. */
        fun onAccepted(
            deviceId: Int,
            status: String,
            bleAnchorUuid: String?,
            bleMaxDistanceMeters: Double?,
        )
        fun onRejected(message: String)

        /**
         * Handshake ditolak middleware autentikasi gateway. isCredentialProblem
         * true = rahasia salah/hilang/device perlu daftar ulang (klaim ulang);
         * false = gangguan server sementara (coba sambung lagi nanti).
         */
        fun onAuthFailed(message: String, isCredentialProblem: Boolean)
        fun onCommandPush(commandId: Int?, commandType: String, reasonNote: String?)
        fun onConnected()
        fun onDisconnected()
    }

    private var socket: Socket? = null

    fun connect(deviceUuid: String, deviceSecret: String, siteCode: String, appBuildVersion: String) {
        val options = IO.Options.builder()
            // Dikirim di handshake (bukan di device:hello) supaya gateway
            // menolak koneksi palsu sebelum handler apa pun sempat jalan.
            .setAuth(mapOf("deviceUuid" to deviceUuid, "deviceSecret" to deviceSecret))
            .setTransports(arrayOf("websocket"))
            .setReconnection(true)
            .setReconnectionDelay(2000)
            .setReconnectionDelayMax(15000)
            .build()

        val sock = IO.socket("$gatewayBaseUrl/device", options)
        socket = sock

        sock.on(Socket.EVENT_CONNECT) {
            Log.i(TAG, "connected, sending device:hello")
            listener.onConnected()
            val hello = JSONObject().apply {
                put("deviceUuid", deviceUuid)
                put("siteCode", siteCode)
                put("appBuildVersion", appBuildVersion)
            }
            sock.emit("device:hello", hello)
        }

        sock.on(Socket.EVENT_DISCONNECT) {
            Log.w(TAG, "disconnected")
            listener.onDisconnected()
        }

        // Penolakan middleware gateway datang sebagai CONNECT_ERROR berisi
        // JSONObject {message, data: {code}}; socket.io-client TIDAK menyambung
        // ulang sendiri setelah itu. Error transport (bukan JSONObject) tetap
        // ditangani mekanisme reconnection bawaan.
        sock.on(Socket.EVENT_CONNECT_ERROR) { args ->
            val error = args.firstOrNull() as? JSONObject
            if (error == null) {
                Log.w(TAG, "connect error transport: ${args.firstOrNull()}")
                return@on
            }
            val code = error.optJSONObject("data")?.optString("code").orEmpty()
            Log.w(TAG, "handshake ditolak gateway, code=$code")
            listener.onAuthFailed(
                error.optString("message", "Ditolak server"),
                code == AUTH_CODE_INVALID_CREDENTIALS || code == AUTH_CODE_REENROLL_REQUIRED,
            )
        }

        sock.on("device:accepted") { args ->
            val data = args.firstOrNull() as? JSONObject ?: return@on
            val bleAnchorUuid = if (data.isNull("bleAnchorUuid") || !data.has("bleAnchorUuid")) {
                null
            } else {
                data.getString("bleAnchorUuid")
            }
            val bleMaxDistanceMeters = if (data.isNull("bleMaxDistanceMeters") || !data.has("bleMaxDistanceMeters")) {
                null
            } else {
                data.optDouble("bleMaxDistanceMeters").takeIf { !it.isNaN() }
            }
            listener.onAccepted(
                data.optInt("deviceId"),
                data.optString("status"),
                bleAnchorUuid,
                bleMaxDistanceMeters,
            )
        }

        sock.on("device:rejected") { args ->
            val data = args.firstOrNull() as? JSONObject ?: return@on
            listener.onRejected(data.optString("message", "Ditolak server"))
        }

        sock.on("command:push") { args ->
            val data = args.firstOrNull() as? JSONObject ?: return@on
            val commandId = if (data.has("command_id")) data.optInt("command_id") else null
            listener.onCommandPush(
                commandId,
                data.optString("command_type"),
                if (data.isNull("reason_note") || !data.has("reason_note")) null else data.getString("reason_note"),
            )
        }

        sock.connect()
    }

    fun sendLocation(
        source: String,
        latitude: Double?,
        longitude: Double?,
        bleDistanceMeters: Double?,
        bleRssi: Int?,
        batteryLevel: Int?,
        ssid: String?,
        ip: String?,
        nearbyBeaconUuid: String? = null,
        nearbyBeaconDistanceMeters: Double? = null,
        accuracyMeters: Float? = null,
        provider: String? = null,
        fixTime: Long? = null,
        isMock: Boolean? = null,
    ) {
        val payload = JSONObject().apply {
            put("source", source)
            put("latitude", latitude)
            put("longitude", longitude)
            put("bleDistanceMeters", bleDistanceMeters)
            put("bleRssi", bleRssi)
            put("batteryLevel", batteryLevel)
            put("ssid", ssid)
            put("ip", ip)
            // UUID+jarak BLE TERDEKAT selain anchor tetap -- dicocokkan server
            // ke master_anchor_registry (APK Master yang sedang login), lihat
            // BleBeaconScanner.strongestOtherReading().
            if (nearbyBeaconUuid != null) put("nearbyBeaconUuid", nearbyBeaconUuid)
            if (nearbyBeaconDistanceMeters != null) put("nearbyBeaconDistanceMeters", nearbyBeaconDistanceMeters)
            // Kelengkapan lokasi: radius akurasi (m), sumber fix (gps/network/fused/passive), dan
            // waktu fix diambil (epoch ms) -- bisa lebih tua dari waktu kirim kalau belum ada fix baru.
            if (accuracyMeters != null) put("accuracyMeters", accuracyMeters.toDouble())
            if (provider != null) put("provider", provider)
            if (fixTime != null) put("fixTime", fixTime)
            // Anti-palsu: true kalau fix berasal dari aplikasi mock location (GPS palsu).
            if (isMock != null) put("isMock", isMock)
        }
        socket?.emit("device:location", payload)
    }

    /** Detail perangkat (lihat DeviceInfoCollector) -- disimpan gateway ke tabel devices. */
    fun sendDeviceInfo(info: JSONObject) {
        socket?.emit("device:info", info)
    }

    /**
     * Laporan perintah ke server. result: "received" (diterima), "executed" (berhasil dijalankan),
     * atau "failed" (gagal; message berisi alasan yang tampil di dashboard). Gateway versi lama
     * mengabaikan field tambahan dan hanya membaca commandId (= diterima).
     */
    fun reportCommand(commandId: Int, result: String, message: String? = null) {
        val payload = JSONObject().apply {
            put("commandId", commandId)
            put("result", result)
            if (message != null) put("message", message)
        }
        socket?.emit("command:ack", payload)
    }

    val isConnected: Boolean
        get() = socket?.connected() == true

    /**
     * Sambung ulang SEKARANG (dipanggil saat jaringan HP baru tersedia lagi) tanpa menunggu jeda
     * reconnect bawaan yang bisa sampai 15 detik.
     */
    fun reconnectNow() {
        val sock = socket ?: return
        if (!sock.connected()) sock.connect()
    }

    fun disconnect() {
        socket?.disconnect()
        socket?.off()
        socket = null
    }

    companion object {
        private const val TAG = "GatewaySocketClient"

        // Harus sama dengan DeviceAuthErrorCode di realtime-gateway/start/socket.ts.
        private const val AUTH_CODE_INVALID_CREDENTIALS = "invalid_credentials"
        private const val AUTH_CODE_REENROLL_REQUIRED = "reenroll_required"
    }
}
