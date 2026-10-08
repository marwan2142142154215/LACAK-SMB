package com.lacaksmb.tracker.service

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.ParcelUuid
import android.util.Log
import java.util.UUID

/**
 * Mode BLE geofence: scan terus-menerus untuk SATU anchor tertentu (device
 * referensi diam di lokasi, UUID-nya dikirim server lewat device:accepted
 * -- lihat GatewaySocketClient & TrackerForegroundService). RSSI sinyal
 * anchor dipakai mengestimasi jarak dalam meter, dilaporkan tiap heartbeat
 * sebagai ble_distance_meters -- jauh lebih presisi dari GPS untuk jarak
 * dekat (beberapa meter), karena tidak bergantung sinyal satelit sama
 * sekali. Kebalikan dari BleBeaconAdvertiser (yang MEMANCARKAN identitas
 * device ini sendiri, dipakai APK master untuk mencari device secara
 * manual) -- scanner ini yang MEMBACA sinyal device lain.
 */
class BleBeaconScanner(private val context: Context) {

    /**
     * Jendela sampel RSSI mentah (waktu, rssi) -- dipakai median, bukan
     * pembacaan tunggal. Satu paket BLE sangat berisik (pantulan dinding,
     * orientasi antena, interferensi WiFi 2.4GHz) dan estimasi jarak itu
     * EKSPONENSIAL terhadap RSSI: lompatan puluhan dB antar paket yang cuma
     * puluhan milidetik itu jaraknya berpuluhan meter. Median jendela 15
     * detik membunuh outlier sesaat sambil tetap merespons gerakan nyata
     * (heartbeat cuma tiap 30 detik, lag median ~setengah jendela tidak
     * berarti). Menggantikan EMA per-paket sebelumnya yang terlalu cepat
     * mengikuti satu paket yang menyimpang.
     */
    private val sampleLock = Any()
    private val recentSamples = ArrayDeque<Pair<Long, Int>>()

    @Volatile
    private var latestRssiAtMillis: Long = 0L

    @Volatile
    private var targetUuid: String? = null

    private var scanner: BluetoothLeScanner? = null
    private var isScanning = false

    /** Dipanggil tiap kali status terhadap radius (LOST/IN/OUT) berubah. */
    interface CrossingListener {
        fun onCrossingChanged(isInsideRadius: Boolean, distanceMeters: Double?)
    }

    @Volatile
    private var crossingListener: CrossingListener? = null

    @Volatile
    private var radiusMeters: Double? = null

    /** Zona status jarak terhadap radius, dipakai deteksi perpindahan (edge). */
    private enum class Zone { LOST, IN, OUT }

    @Volatile
    private var lastZone: Zone = Zone.LOST

    /**
     * Set radius (meter) untuk deteksi perpindahan. Dipanggil service saat
     * server mengirim bleMaxDistanceMeters lewat device:accepted.
     */
    fun setRadiusMeters(meters: Double?) {
        radiusMeters = meters
    }

    fun setCrossingListener(listener: CrossingListener?) {
        crossingListener = listener
    }

    private val callback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val now = System.currentTimeMillis()
            synchronized(sampleLock) {
                recentSamples.addLast(now to result.rssi)
                // Buang sampel luar jendela + batasi ukuran (safety valve
                // kalau device sangat dermis mengirim paket).
                while (recentSamples.isNotEmpty() && now - recentSamples.first().first > RSSI_WINDOW_MS) {
                    recentSamples.removeFirst()
                }
                while (recentSamples.size > MAX_SAMPLES) {
                    recentSamples.removeFirst()
                }
            }
            latestRssiAtMillis = now
            evaluateCrossing()
        }

        override fun onScanFailed(errorCode: Int) {
            Log.w(TAG, "BLE scan gagal, errorCode=$errorCode")
        }
    }

    /**
     * Deteksi PERGANTIAN status terhadap radius di sisi phone, dipanggil dari
     * callback scan (nyaris real-time, bukan nunggu heartbeat 30 detik). Yang
     * dilaporkan ke service hanya saat zona BERUBAH (edge) -- bukan tiap paket,
     * supaya tidak membanjiri socket saat device diam di satu zona.
     *
     * Zona dihitung dari MEDIAN jendela (bukan satu paket) supaya noise RSSI
     * sesaat tidak memicu laporan keluar-masuk palsu; LOST hanya setelah
     * READING_MAX_AGE_MS tidak ada paket sama sekali.
     */
    private fun evaluateCrossing() {
        val radius = radiusMeters ?: return
        val reading = latestReading()
        val zone = when {
            reading == null -> Zone.LOST
            reading.second > radius -> Zone.OUT
            else -> Zone.IN
        }
        if (zone == lastZone) return
        lastZone = zone
        crossingListener?.onCrossingChanged(zone == Zone.IN, reading?.second)
    }

    /** Mulai scan untuk anchorUuid tertentu. Memanggil ulang dengan UUID baru otomatis restart filter. */
    @SuppressLint("MissingPermission")
    fun startScanningFor(anchorUuid: String) {
        if (isScanning && targetUuid == anchorUuid) return
        stop()

        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = manager?.adapter
        if (adapter == null || !adapter.isEnabled) {
            Log.w(TAG, "Bluetooth tidak aktif — scan anchor BLE tidak bisa jalan")
            return
        }
        val leScanner = adapter.bluetoothLeScanner ?: return

        val filter = try {
            ScanFilter.Builder().setServiceUuid(ParcelUuid(UUID.fromString(anchorUuid))).build()
        } catch (_: IllegalArgumentException) {
            Log.w(TAG, "anchorUuid bukan UUID valid: $anchorUuid")
            return
        }

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        try {
            leScanner.startScan(listOf(filter), settings, callback)
            scanner = leScanner
            targetUuid = anchorUuid
            isScanning = true
            clearSamples()
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
        targetUuid = null
        // Reset zona supaya setelah scan dimulai ulang, perpindahan pertama
        // tetap terlapor (bukan dianggap "sudah di zona yang sama").
        lastZone = Zone.LOST
        clearSamples()
    }

    private fun clearSamples() {
        synchronized(sampleLock) { recentSamples.clear() }
        latestRssiAtMillis = 0L
    }

    /**
     * Pasangan (rssi, estimasi_meter) dari MEDIAN jendela sampel terakhir, atau
     * null kalau belum pernah dengar anchor-nya sama sekali -- ATAU kalau tidak
     * ada paket yang masuk lebih baru dari READING_MAX_AGE_MS. Tanpa batas umur
     * ini, anchor yang sudah keluar jangkauan (atau Bluetooth-nya mati) akan
     * tetap dilaporkan "dekat" selamanya memakai RSSI lama yang ter-cache --
     * auto-lock tidak akan pernah menyala walau device sungguhan sudah pergi
     * jauh. Median (bukan nilai terakhir) supaya satu paket yang menyimpang
     * tidak mengubah estimasi jarak puluhan meter di heartbeat berikutnya.
     */
    fun latestReading(): Pair<Int, Double>? {
        if (System.currentTimeMillis() - latestRssiAtMillis > READING_MAX_AGE_MS) return null
        val rssi = synchronized(sampleLock) {
            if (recentSamples.isEmpty()) return null
            // Buang sampel yang sudah tua bahkan kalau tidak ada paket baru
            // (jendela tidak di-prune kalau tidak ada callback masuk).
            val cutoff = System.currentTimeMillis() - RSSI_WINDOW_MS
            while (recentSamples.isNotEmpty() && recentSamples.first().first < cutoff) {
                recentSamples.removeFirst()
            }
            if (recentSamples.isEmpty()) return null
            recentSamples.map { it.second }.sorted()[recentSamples.size / 2]
        }
        return rssi to estimateDistanceMeters(rssi)
    }

    companion object {
        private const val TAG = "TrackerBleScan"

        /** Anchor dianggap hilang kalau tidak ada paket BLE masuk selama ini. */
        private const val READING_MAX_AGE_MS = 15_000L

        /** Lebar jendela median -- ~setengah dari periode heartbeat (30 detik). */
        private const val RSSI_WINDOW_MS = 15_000L

        /** Safety valve ukuran jendela, jauh di atas jumlah wajar paket dalam 15 detik. */
        private const val MAX_SAMPLES = 512

        /** Model log-distance umum (sama dipakai android-master-app BleRadarScanner) -- perkiraan, bukan presisi tinggi. */
        fun estimateDistanceMeters(rssi: Int, txPowerAt1m: Int = -59): Double {
            if (rssi == 0) return -1.0
            val ratio = (txPowerAt1m - rssi) / 20.0
            return Math.pow(10.0, ratio)
        }
    }
}
