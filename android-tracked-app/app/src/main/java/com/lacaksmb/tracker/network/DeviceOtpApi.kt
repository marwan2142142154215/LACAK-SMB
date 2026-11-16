package com.lacaksmb.tracker.network

import com.lacaksmb.tracker.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Verifikasi kode sekali-pakai ke backend-api. Endpoint publik tanpa auth (device yang terkunci /
 * akan dilepas tidak bisa login) — dibatasi rate limit di server, lihat backend-api
 * DeviceOtpController::verify()/release() (throttle:10,1).
 */
object DeviceOtpApi {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    /** Buka kunci mandiri: HP yang sedang locked kembali bisa dipakai. */
    suspend fun verify(deviceUuid: String, code: String): Result<Unit> =
        post("/device-otp/verify", deviceUuid, code)

    /**
     * Lepas perangkat: server menandai device dilepas. Pemanggil (MainActivity) lalu mencabut kunci
     * lokasi & blokir uninstall dan melepas Device Owner/Admin lewat DevicePolicyRelease.
     */
    suspend fun verifyRelease(deviceUuid: String, code: String): Result<Unit> =
        post("/device-otp/release", deviceUuid, code)

    private suspend fun post(path: String, deviceUuid: String, code: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            try {
                val payload = JSONObject().apply {
                    put("device_uuid", deviceUuid)
                    put("code", code)
                }
                val body = payload.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("${BuildConfig.BACKEND_API_URL}$path")
                    .post(body)
                    .build()

                client.newCall(request).execute().use { response ->
                    val raw = response.body?.string().orEmpty()
                    val json = try {
                        JSONObject(raw)
                    } catch (_: Exception) {
                        null
                    }
                    val success = json?.optBoolean("success", false) ?: false
                    if (response.isSuccessful && success) {
                        Result.success(Unit)
                    } else {
                        val message = json?.optString("message")?.takeIf { it.isNotBlank() }
                            ?: "Kode salah atau sudah kedaluwarsa, coba lagi"
                        Result.failure(IOException(message))
                    }
                }
            } catch (_: Exception) {
                Result.failure(IOException("Tidak bisa menghubungi server — periksa koneksi internet"))
            }
        }
}
