package com.lacaksmb.tracker.service

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.ParcelUuid
import android.util.Log
import java.util.UUID

/**
 * Memancarkan beacon BLE berisi device_uuid device ini sebagai 128-bit
 * Service UUID — "alat utama pelacak" jarak dekat: APK master cukup
 * men-scan Service UUID yang cocok dan membaca RSSI untuk estimasi
 * jarak/proximity (makin kuat sinyal = makin dekat), berguna saat GPS
 * tidak presisi (dalam ruangan/gedung). GPS tetap dipakai untuk posisi
 * jarak jauh di peta — BLE untuk "dingin/panas" saat sudah dekat lokasi.
 *
 * Tidak butuh hardware tambahan (tag/anchor fisik) — tracker app di
 * device target SENDIRI yang jadi pemancarnya.
 */
class BleBeaconAdvertiser(private val context: Context) {

    private var advertiser: BluetoothLeAdvertiser? = null
    private var isAdvertising = false

    private val callback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
            Log.i(TAG, "BLE advertising dimulai")
        }

        override fun onStartFailure(errorCode: Int) {
            Log.w(TAG, "BLE advertising gagal dimulai, errorCode=$errorCode")
        }
    }

    @SuppressLint("MissingPermission")
    fun start(deviceUuid: String) {
        if (isAdvertising || deviceUuid.isBlank()) return

        val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter: BluetoothAdapter? = bluetoothManager?.adapter
        if (adapter == null || !adapter.isEnabled) {
            Log.w(TAG, "Bluetooth tidak aktif/tidak tersedia — beacon tidak dipancarkan")
            return
        }

        val leAdvertiser = adapter.bluetoothLeAdvertiser
        if (leAdvertiser == null) {
            Log.w(TAG, "Device tidak mendukung BLE advertising")
            return
        }

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(false)
            .build()

        val data = try {
            AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceUuid(ParcelUuid(UUID.fromString(deviceUuid)))
                .build()
        } catch (_: IllegalArgumentException) {
            Log.w(TAG, "device_uuid bukan UUID valid, beacon tidak dipancarkan")
            return
        }

        try {
            leAdvertiser.startAdvertising(settings, data, callback)
            advertiser = leAdvertiser
            isAdvertising = true
        } catch (e: Exception) {
            Log.w(TAG, "startAdvertising gagal: ${e.message}")
        }
    }

    @SuppressLint("MissingPermission")
    fun stop() {
        if (!isAdvertising) return
        try {
            advertiser?.stopAdvertising(callback)
        } catch (_: Exception) {
            // Adapter mungkin sudah mati — aman diabaikan.
        }
        isAdvertising = false
        advertiser = null
    }

    companion object {
        private const val TAG = "TrackerBle"
    }
}
