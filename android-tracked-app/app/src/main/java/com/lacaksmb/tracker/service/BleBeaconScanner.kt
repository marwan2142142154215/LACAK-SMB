package com.lacaksmb.tracker.service

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.util.Log

/**
 * Mode BLE geofence: scan TANPA FILTER (bukan cuma satu anchor tertentu) --
 * dipakai dua hal independen:
 *  1. Anchor tetap (device referensi diam di lokasi, UUID-nya dikirim server
 *     lewat device:accepted) -- lihat latestReading()/setRadiusMeters().
 *  2. APK Master yang kebetulan lewat/berada dekat (anchor BERGERAK, lihat
 *     realtime-gateway master_anchor_registry.ts) -- lihat
 *     strongestOtherReading(). UUID-nya TIDAK diketahui device ini
 *     sebelumnya (siapa pun yang sedang login APK Master bisa jadi anchor),
 *     makanya scan harus tanpa filter dan server-lah yang memutuskan
 *     (lewat registry login) apakah UUID yang terdeteksi itu memang APK
 *     Master yang berwenang atau cuma perangkat BLE lain yang kebetulan ada
 *     di sekitar (headset, dst -- dilaporkan apa adanya, diabaikan server
 *     kalau tidak cocok).
 *
 * Sebelumnya scan dengan ScanFilter per-UUID (scan terpisah tiap ganti
 * target) -- diganti scan tunggal tanpa filter + sampel per-UUID, supaya
 * kedua kebutuhan di atas jalan dari SATU sesi scan BLE saja (Android
 * membatasi jumlah sesi scan bersamaan per app).
 */
class BleBeaconScanner(private val context: Context) {

    /**
     * Jendela sampel RSSI mentah PER UUID (waktu, rssi) -- dipakai median,
     * bukan pembacaan tunggal. Satu paket BLE sangat berisik (pantulan
     * dinding, orientasi antena, interferensi WiFi 2.4GHz) dan estimasi
     * jarak itu EKSPONENSIAL terhadap RSSI: lompatan puluhan dB antar paket
     * yang cuma puluhan milidetik itu jaraknya berpuluhan meter. Median
     * jendela 15 detik membunuh outlier sesaat sambil tetap merespons
     * gerakan nyata (heartbeat cuma tiap 30 detik, lag median ~setengah
     * jendela tidak berarti).
     */
    private val sampleLock = Any()
    private val samplesByUuid = HashMap<String, ArrayDeque<Pair<Long, Int>>>()
    private val lastSeenAtByUuid = HashMap<String, Long>()

    @Volatile
    private var targetUuid: String? = null

    private var scanner: BluetoothLeScanner? = null
    private var isScanning = false

    /** Dipanggil tiap kali status terhadap radius (LOST/IN/OUT) berubah -- khusus anchor TETAP (targetUuid). */
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
     * Set radius (meter) untuk deteksi perpindahan anchor TETAP. Dipanggil
     * service saat server mengirim bleMaxDistanceMeters lewat device:accepted.
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
            val uuids = result.scanRecord?.serviceUuids ?: return
            for (parcelUuid in uuids) {
                val uuid = parcelUuid.uuid.toString()
                synchronized(sampleLock) {
                    val deque = samplesByUuid.getOrPut(uuid) { ArrayDeque() }
                    deque.addLast(now to result.rssi)
                    while (deque.isNotEmpty() && now - deque.first().first > RSSI_WINDOW_MS) {
                        deque.removeFirst()
                    }
                    while (deque.size > MAX_SAMPLES) {
                        deque.removeFirst()
                    }
                }
                lastSeenAtByUuid[uuid] = now
            }
            if (targetUuid != null && uuids.any { it.uuid.toString() == targetUuid }) {
                evaluateCrossing()
            }
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

    /**
     * Mulai scan TANPA FILTER (semua perangkat BLE di sekitar). Dipanggil
     * sekali saat service connect ke gateway, berjalan terus selama service
     * hidup -- anchor tetap (targetUuid) di-set terpisah lewat
     * startScanningFor(), tidak perlu restart sesi scan.
     */
    @SuppressLint("MissingPermission")
    fun start() {
        if (isScanning) return

        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = manager?.adapter
        if (adapter == null || !adapter.isEnabled) {
            Log.w(TAG, "Bluetooth tidak aktif — scan BLE tidak bisa jalan")
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

    /** Set/ganti UUID anchor TETAP yang dipantau untuk crossing radius -- scan tetap satu sesi yang sama (start()). */
    fun startScanningFor(anchorUuid: String) {
        if (targetUuid == anchorUuid) return
        targetUuid = anchorUuid
        lastZone = Zone.LOST
        start()
    }

    /** Matikan pemantauan anchor tetap (tidak menghentikan scan BLE-nya -- itu via stop()). */
    fun clearAnchor() {
        targetUuid = null
        radiusMeters = null
        crossingListener = null
        lastZone = Zone.LOST
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
        lastZone = Zone.LOST
        synchronized(sampleLock) { samplesByUuid.clear() }
        lastSeenAtByUuid.clear()
    }

    /**
     * Pasangan (rssi, estimasi_meter) anchor TETAP dari MEDIAN jendela sampel
     * terakhir, atau null kalau belum pernah dengar sama sekali -- ATAU kalau
     * tidak ada paket yang masuk lebih baru dari READING_MAX_AGE_MS. Tanpa
     * batas umur ini, anchor yang sudah keluar jangkauan (atau Bluetooth-nya
     * mati) akan tetap dilaporkan "dekat" selamanya memakai RSSI lama yang
     * ter-cache -- auto-lock tidak akan pernah menyala walau device sungguhan
     * sudah pergi jauh. Median (bukan nilai terakhir) supaya satu paket yang
     * menyimpang tidak mengubah estimasi jarak puluhan meter di heartbeat
     * berikutnya.
     */
    fun latestReading(): Pair<Int, Double>? = targetUuid?.let { readingFor(it) }

    private fun readingFor(uuid: String): Pair<Int, Double>? {
        val lastSeen = lastSeenAtByUuid[uuid] ?: return null
        if (System.currentTimeMillis() - lastSeen > READING_MAX_AGE_MS) return null
        val rssi = synchronized(sampleLock) {
            val deque = samplesByUuid[uuid] ?: return null
            val cutoff = System.currentTimeMillis() - RSSI_WINDOW_MS
            while (deque.isNotEmpty() && deque.first().first < cutoff) {
                deque.removeFirst()
            }
            if (deque.isEmpty()) return null
            deque.map { it.second }.sorted()[deque.size / 2]
        }
        return rssi to estimateDistanceMeters(rssi)
    }

    /**
     * UUID+bacaan TERDEKAT di antara semua perangkat BLE yang sedang
     * terdeteksi, SELAIN excludeUuid (anchor tetap, supaya tidak dobel
     * dihitung) -- dipakai melaporkan "APK Master terdekat" tiap heartbeat.
     * Server (master_anchor_registry) yang memutuskan apakah UUID ini
     * memang APK Master berwenang; di sini cuma melaporkan sinyal terkuat
     * apa adanya.
     */
    fun strongestOtherReading(excludeUuid: String?): Triple<String, Int, Double>? {
        val now = System.currentTimeMillis()
        val candidates = synchronized(sampleLock) { samplesByUuid.keys.toList() }
        var best: Triple<String, Int, Double>? = null
        for (uuid in candidates) {
            if (uuid == excludeUuid) continue
            val lastSeen = lastSeenAtByUuid[uuid] ?: continue
            if (now - lastSeen > READING_MAX_AGE_MS) continue
            val reading = readingFor(uuid) ?: continue
            if (best == null || reading.second < best.third) {
                best = Triple(uuid, reading.first, reading.second)
            }
        }
        return best
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
