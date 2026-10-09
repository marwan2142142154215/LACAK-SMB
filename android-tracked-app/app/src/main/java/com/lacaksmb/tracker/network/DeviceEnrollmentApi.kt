package com.lacaksmb.tracker.network

import android.util.Log
import com.lacaksmb.tracker.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Mengambil rahasia device dari backend-api setelah admin mendaftarkan
 * device_uuid ini (POST /device-enrollments/claim, lihat backend-api
 * DeviceEnrollmentController). Rahasia hanya diterbitkan sekali per
 * pendaftaran, jadi hasilnya wajib langsung disimpan ke DeviceIdentityStore.
 */
object DeviceEnrollmentApi {
    private const val TAG = "DeviceEnrollmentApi"

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    suspend fun claim(deviceUuid: String): Result<String> = withContext(Dispatchers.IO) {
        try {
            val payload = JSONObject().apply { put("device_uuid", deviceUuid) }
            val body = payload.toString().toRequestBody("application/json".toMediaType())
            val request = Request.Builder()
                .url("${BuildConfig.BACKEND_API_URL}/device-enrollments/claim")
                .post(body)
                .build()

            client.newCall(request).execute().use { response ->
                val json = parseJson(response.body?.string().orEmpty())
                val deviceSecret = json?.optJSONObject("data")?.optString("device_secret").orEmpty()
                if (response.isSuccessful && json?.optBoolean("success", false) == true && deviceSecret.isNotBlank()) {
                    Result.success(deviceSecret)
                } else {
                    val message = json?.optString("message")?.takeIf { it.isNotBlank() }
                        ?: "Device belum didaftarkan admin"
                    Result.failure(IOException(message))
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "klaim enrollment gagal terhubung ke server", e)
            Result.failure(IOException("Tidak bisa menghubungi server — periksa koneksi internet"))
        } catch (e: IllegalArgumentException) {
            // BACKEND_API_URL yang ditanam saat build tidak valid — kesalahan build, bukan jaringan.
            Log.e(TAG, "alamat backend untuk klaim enrollment tidak valid", e)
            Result.failure(IOException("Konfigurasi aplikasi tidak valid, hubungi admin"))
        }
    }

    private fun parseJson(raw: String): JSONObject? = try {
        JSONObject(raw)
    } catch (e: JSONException) {
        Log.w(TAG, "respons klaim enrollment bukan JSON", e)
        null
    }
}
