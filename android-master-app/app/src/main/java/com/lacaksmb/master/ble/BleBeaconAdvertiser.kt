package com.lacaksmb.master.ble

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
 * Sama persis pola android-tracked-app BleBeaconAdvertiser -- APK Master
 * memancarkan beacon BLE berisi UUID "anchor bergerak"-nya sendiri (lihat
 * MasterAnchorService) selagi login, supaya APK Lacak yang mendeteksinya
 * dalam radius aman bisa menganggap device di tempat aman (realtime-gateway
 * master_anchor_registry.ts), persis fungsi anchor BLE fisik tapi bisa
 * dibawa-bawa staf.
 */
class BleBeaconAdvertiser(private val context: Context) {

    private var advertiser: BluetoothLeAdvertiser? = null
    private var isAdvertising = false

    private val callback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
            Log.i(TAG, "BLE advertising (anchor master) dimulai")
        }

        override fun onStartFailure(errorCode: Int) {
            Log.w(TAG, "BLE advertising gagal dimulai, errorCode=$errorCode")
        }
    }

    @SuppressLint("MissingPermission")
    fun start(beaconUuid: String) {
        if (isAdvertising || beaconUuid.isBlank()) return

        val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter: BluetoothAdapter? = bluetoothManager?.adapter
        if (adapter == null || !adapter.isEnabled) {
            Log.w(TAG, "Bluetooth tidak aktif/tidak tersedia — anchor master tidak dipancarkan")
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
                .addServiceUuid(ParcelUuid(UUID.fromString(beaconUuid)))
                .build()
        } catch (_: IllegalArgumentException) {
            Log.w(TAG, "beaconUuid bukan UUID valid, anchor master tidak dipancarkan")
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
        private const val TAG = "MasterBle"
    }
}
