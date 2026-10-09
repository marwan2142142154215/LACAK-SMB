package com.lacaksmb.tracker.service

import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.UUID

/**
 * UUID beacon BLE = 16 byte pertama SHA-256("beacon:" + device_uuid).
 *
 * device_uuid adalah identitas login ke realtime-gateway, jadi tidak boleh
 * dipancarkan apa adanya ke siapa pun di sekitar. Turunan ini boleh publik
 * karena login sekarang juga butuh rahasia device. WAJIB sama persis dengan
 * beaconUuidFor() di realtime-gateway/app/services/device_credentials.ts dan
 * BeaconUuid.kt di android-master-app — kalau berbeda, scan anchor & radar
 * tidak akan menemukan beacon-nya.
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
