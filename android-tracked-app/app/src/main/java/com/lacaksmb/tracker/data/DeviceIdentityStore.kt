package com.lacaksmb.tracker.data

import android.content.Context
import com.lacaksmb.tracker.BuildConfig
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

        // Rahasia autentikasi ke gateway (diterbitkan backend sekali saat
        // klaim enrollment). DataStore ini ada di penyimpanan privat app;
        // EncryptedSharedPreferences tidak dipakai karena belum jadi
        // dependensi proyek.
        val DEVICE_SECRET = stringPreferencesKey("device_secret")

        // Rahasia zero-touch dari BuildConfig hanya dipakai sekali. Kalau
        // gateway kemudian menolaknya (mis. admin menekan Daftar Ulang),
        // device harus mengklaim rahasia baru, bukan memasang ulang yang lama.
        val BUILD_SECRET_APPLIED = booleanPreferencesKey("build_secret_applied")
    }

    val deviceUuidFlow: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[Keys.DEVICE_UUID] ?: ""
    }

    val siteCodeFlow: Flow<String> = context.dataStore.data.map { prefs -> prefs[Keys.SITE_CODE] ?: "" }

    val gatewayUrlFlow: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[Keys.GATEWAY_URL] ?: DEFAULT_GATEWAY_URL
    }

    val isEnrolledFlow: Flow<Boolean> = context.dataStore.data.map { prefs -> prefs[Keys.IS_ENROLLED] ?: false }

    /**
     * Dipanggil sekali saat app pertama kali dibuka. Device identitas
     * zero-touch (lihat build.gradle.kts DEVICE_UUID) SELALU diprioritaskan
     * kalau ada -- backend-api yang generate device_uuid itu & sudah
     * mendaftarkan baris Device-nya SEBELUM APK ini di-build, jadi device
     * TIDAK BOLEH bikin UUID acak sendiri (acak sendiri = device_uuid yang
     * tidak pernah terdaftar, gateway akan menolak device:hello-nya).
     * ensureDeviceSecretFromBuild() mengikuti pola yang sama untuk secret.
     */
    suspend fun ensureDeviceUuid(): String {
        val current = context.dataStore.data.map { it[Keys.DEVICE_UUID] }.first()
        if (!current.isNullOrBlank()) return current

        if (BuildConfig.DEVICE_UUID.isNotBlank()) {
            context.dataStore.edit { prefs -> prefs[Keys.DEVICE_UUID] = BuildConfig.DEVICE_UUID }
            return BuildConfig.DEVICE_UUID
        }

        val generated = UUID.randomUUID().toString()
        context.dataStore.edit { prefs -> prefs[Keys.DEVICE_UUID] = generated }
        return generated
    }

    /**
     * Simpan rahasia device yang ditanam saat build (zero-touch, lihat
     * build.gradle.kts DEVICE_SECRET) supaya APK langsung terhubung tanpa
     * klaim enrollment. Hanya sekali per instalasi; aman dipanggil berulang.
     */
    suspend fun ensureDeviceSecretFromBuild() {
        if (BuildConfig.DEVICE_SECRET.isBlank()) return
        context.dataStore.edit { prefs ->
            if (prefs[Keys.BUILD_SECRET_APPLIED] == true) return@edit
            if (prefs[Keys.DEVICE_SECRET].isNullOrBlank()) {
                prefs[Keys.DEVICE_SECRET] = BuildConfig.DEVICE_SECRET
            }
            prefs[Keys.BUILD_SECRET_APPLIED] = true
        }
    }

    suspend fun saveEnrollment(siteCode: String, gatewayUrl: String) {
        context.dataStore.edit { prefs ->
            prefs[Keys.SITE_CODE] = siteCode
            prefs[Keys.GATEWAY_URL] = gatewayUrl
            prefs[Keys.IS_ENROLLED] = true
        }
    }

    suspend fun saveDeviceSecret(deviceSecret: String) {
        context.dataStore.edit { prefs -> prefs[Keys.DEVICE_SECRET] = deviceSecret }
    }

    /** Dipanggil saat gateway menolak rahasia ini, supaya device mengklaim ulang. */
    suspend fun clearDeviceSecret() {
        context.dataStore.edit { prefs -> prefs.remove(Keys.DEVICE_SECRET) }
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
    val deviceSecret: String,
) {
    // Jangan sampai rahasia ikut tercetak kalau snapshot ini pernah di-log.
    override fun toString(): String =
        "DeviceIdentitySnapshot(deviceUuid=$deviceUuid, siteCode=$siteCode, gatewayUrl=$gatewayUrl, " +
            "isEnrolled=$isEnrolled, hasDeviceSecret=${deviceSecret.isNotBlank()})"
}
