package com.lacaksmb.tracker.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.util.UUID

private val Context.dataStore by preferencesDataStore(name = "tracker_identity")

/**
 * Identitas device tersimpan secara lokal: device_uuid dibuat sekali seumur
 * instalasi (dipakai untuk didaftarkan oleh admin lewat dashboard/APK
 * master), site_code diisi saat enrollment, dan gatewayUrl bisa disesuaikan
 * untuk keperluan pengujian lokal sebelum APK resmi per-site tersedia
 * (lihat README untuk alur produksi: site_code seharusnya ditanam otomatis
 * saat build APK per site, bukan diketik manual).
 */
class DeviceIdentityStore(private val context: Context) {

    private object Keys {
        val DEVICE_UUID = stringPreferencesKey("device_uuid")
        val SITE_CODE = stringPreferencesKey("site_code")
        val GATEWAY_URL = stringPreferencesKey("gateway_url")
        val IS_ENROLLED = booleanPreferencesKey("is_enrolled")
        // Kosong sampai admin pasangkan device ini lewat kode pairing
        // (lihat DeviceOtpApi.pair) -- device TETAP bisa connect ke gateway
        // tanpa ini (mode lama, backward-compatible), tapi device:hello
        // tanpa device_secret tidak dipercaya kalau device ini SUDAH pernah
        // dipasangkan (server yang ingat, bukan state lokal ini).
        val DEVICE_SECRET = stringPreferencesKey("device_secret")
    }

    val deviceUuidFlow: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[Keys.DEVICE_UUID] ?: ""
    }

    val deviceSecretFlow: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[Keys.DEVICE_SECRET] ?: ""
    }

    val siteCodeFlow: Flow<String> = context.dataStore.data.map { prefs -> prefs[Keys.SITE_CODE] ?: "" }

    val gatewayUrlFlow: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[Keys.GATEWAY_URL] ?: DEFAULT_GATEWAY_URL
    }

    val isEnrolledFlow: Flow<Boolean> = context.dataStore.data.map { prefs -> prefs[Keys.IS_ENROLLED] ?: false }

    /** Dipanggil sekali saat app pertama kali dibuka — bikin UUID kalau belum ada. */
    suspend fun ensureDeviceUuid(): String {
        val current = context.dataStore.data.map { it[Keys.DEVICE_UUID] }.first()
        if (!current.isNullOrBlank()) return current

        val generated = UUID.randomUUID().toString()
        context.dataStore.edit { prefs -> prefs[Keys.DEVICE_UUID] = generated }
        return generated
    }

    suspend fun saveEnrollment(siteCode: String, gatewayUrl: String) {
        context.dataStore.edit { prefs ->
            prefs[Keys.SITE_CODE] = siteCode
            prefs[Keys.GATEWAY_URL] = gatewayUrl
            prefs[Keys.IS_ENROLLED] = true
        }
    }

    suspend fun saveDeviceSecret(secret: String) {
        context.dataStore.edit { prefs -> prefs[Keys.DEVICE_SECRET] = secret }
    }

    suspend fun snapshot(): DeviceIdentitySnapshot {
        val prefs = context.dataStore.data.first()
        return DeviceIdentitySnapshot(
            deviceUuid = prefs[Keys.DEVICE_UUID] ?: "",
            siteCode = prefs[Keys.SITE_CODE] ?: "",
            gatewayUrl = prefs[Keys.GATEWAY_URL] ?: DEFAULT_GATEWAY_URL,
            isEnrolled = prefs[Keys.IS_ENROLLED] ?: false,
            deviceSecret = prefs[Keys.DEVICE_SECRET] ?: "",
        )
    }

    companion object {
        // Default untuk pengujian lokal (emulator Android -> host Windows).
        const val DEFAULT_GATEWAY_URL = "http://10.0.2.2:3333"
    }
}

data class DeviceIdentitySnapshot(
    val deviceUuid: String,
    val siteCode: String,
    val gatewayUrl: String,
    val isEnrolled: Boolean,
    val deviceSecret: String = "",
)
