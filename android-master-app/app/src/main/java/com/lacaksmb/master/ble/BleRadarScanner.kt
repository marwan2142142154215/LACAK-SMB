package com.lacaksmb.master.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

data class BleSighting(val deviceUuid: String, val rssi: Int, val lastSeenAt: Long)

/**
 * Men-scan beacon BLE yang dipancarkan tracker app (Service UUID =
 * device_uuid device itu). RSSI dipakai sebagai indikator jarak relatif
 * "dingin/panas" saat admin mencari device secara fisik — bukan GPS,
 * cocok untuk dalam ruangan/gedung dimana GPS tidak presisi.
 */
class BleRadarScanner(private val context: Context) {

    private val _sightings = MutableStateFlow<Map<String, BleSighting>>(emptyMap())
    val sightings: StateFlow<Map<String, BleSighting>> = _sightings

    // RSSI halus per device -- lihat komentar EMA di BleBeaconScanner (tracker
    // app): tanpa ini radar menampilkan jarak yang melompat liar antar paket
    // scan (bisa beda puluhan meter dalam hitungan milidetik) walau device
    // diam, karena RSSI mentah satu paket BLE sangat berisik.
    private val smoothedRssiByUuid = mutableMapOf<String, Double>()

    private var scanner: BluetoothLeScanner? = null
    private var isScanning = false

    private val callback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val uuid = result.scanRecord?.serviceUuids?.firstOrNull()?.uuid?.toString() ?: return
            val raw = result.rssi.toDouble()
            val smoothed = smoothedRssiByUuid[uuid]?.let { prev -> EMA_ALPHA * raw + (1 - EMA_ALPHA) * prev } ?: raw
            smoothedRssiByUuid[uuid] = smoothed
            _sightings.update { current ->
                current + (uuid to BleSighting(uuid, smoothed.toInt(), System.currentTimeMillis()))
            }
        }

        override fun onScanFailed(errorCode: Int) {
            Log.w(TAG, "BLE scan gagal, errorCode=$errorCode")
        }
    }

    @SuppressLint("MissingPermission")
    fun start() {
        if (isScanning) return
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = manager?.adapter
        if (adapter == null || !adapter.isEnabled) {
            Log.w(TAG, "Bluetooth tidak aktif — radar BLE tidak bisa jalan")
            return
        }
        val leScanner = adapter.bluetoothLeScanner ?: return

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        try {
            leScanner.startScan(null, settings, callback)
            scanner = leScanner
            isScanning = true
        } catch (e: Exception) {
            Log.w(TAG, "startScan gagal: ${e.message}")
        }
    }

    @SuppressLint("MissingPermission")
    fun stop() {
        if (!isScanning) return
        try {
            scanner?.stopScan(callback)
        } catch (_: Exception) {
            // Adapter mungkin sudah mati — aman diabaikan.
        }
        isScanning = false
        scanner = null
        smoothedRssiByUuid.clear()
    }

    /** Perkiraan jarak meter dari RSSI (model log-distance umum, bukan presisi tinggi). */
    companion object {
        private const val TAG = "MasterBle"
        private const val EMA_ALPHA = 0.2

        fun estimateDistanceMeters(rssi: Int, txPowerAt1m: Int = -59): Double {
            if (rssi == 0) return -1.0
            val ratio = (txPowerAt1m - rssi) / 20.0
            return Math.pow(10.0, ratio)
        }
    }
}
