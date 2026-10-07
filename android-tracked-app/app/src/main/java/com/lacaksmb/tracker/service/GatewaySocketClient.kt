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
        fun onAccepted(deviceId: Int, status: String)
        fun onRejected(message: String)
        fun onCommandPush(commandId: Int?, commandType: String, reasonNote: String?)
        fun onConnected()
        fun onDisconnected()
    }

    private var socket: Socket? = null

    fun connect(deviceUuid: String, siteCode: String, appBuildVersion: String) {
        val options = IO.Options.builder()
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

        sock.on("device:accepted") { args ->
            val data = args.firstOrNull() as? JSONObject ?: return@on
            listener.onAccepted(data.optInt("deviceId"), data.optString("status"))
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
                data.optString("reason_note", null),
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
        }
        socket?.emit("device:location", payload)
    }

    fun acknowledgeCommand(commandId: Int) {
        val payload = JSONObject().apply { put("commandId", commandId) }
        socket?.emit("command:ack", payload)
    }

    fun disconnect() {
        socket?.disconnect()
        socket?.off()
        socket = null
    }

    companion object {
        private const val TAG = "GatewaySocketClient"
    }
}
