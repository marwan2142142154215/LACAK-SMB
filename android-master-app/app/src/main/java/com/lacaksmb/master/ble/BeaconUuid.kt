package com.lacaksmb.master.ble

import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.UUID

/**
 * UUID beacon BLE yang dipancarkan APK pelacak = 16 byte pertama
 * SHA-256("beacon:" + device_uuid). APK pelacak tidak lagi memancarkan
 * device_uuid apa adanya (itu identitas login ke gateway), jadi radar harus
 * menurunkan UUID yang sama dari daftar device untuk mencocokkan sinyal.
 * WAJIB sama persis dengan BeaconUuid.kt di android-tracked-app dan
 * beaconUuidFor() di realtime-gateway/app/services/device_credentials.ts.
 */
object BeaconUuid {

    fun fromDeviceUuid(deviceUuid: String): String {
        val normalizedUuid = deviceUuid.trim().lowercase()
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("beacon:$normalizedUuid".toByteArray(Charsets.UTF_8))
        val buffer = ByteBuffer.wrap(digest, 0, 16)
        return UUID(buffer.long, buffer.long).toString()
    }
}
