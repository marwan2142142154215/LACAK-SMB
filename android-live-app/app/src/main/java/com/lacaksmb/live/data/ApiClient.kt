package com.lacaksmb.live.data

import com.lacaksmb.live.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Hasil satu panggilan API: envelope asli backend {success, message, data|errors}. */
sealed class ApiResult {
    data class Ok(val message: String, val data: JSONObject?) : ApiResult()
    data class Fail(val message: String, val httpCode: Int, val errors: JSONObject?) : ApiResult()
}

/**
 * Klien HTTP tipis ke backend-api -- pola sama dengan APK Master (OkHttp +
 * org.json), hanya berisi endpoint yang dipakai APK Live: login/2FA dan
 * siklus sesi Live Kerja (lihat backend-api WorkSessionController).
 */
class ApiClient(private val sessionStore: SessionStore) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private val baseUrl = BuildConfig.BACKEND_API_URL.trimEnd('/')

    private suspend fun execute(request: Request): ApiResult = withContext(Dispatchers.IO) {
        try {
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                val json = try { JSONObject(raw) } catch (_: Exception) { null }
                if (response.isSuccessful && json?.optBoolean("success", false) == true) {
                    ApiResult.Ok(json.optString("message"), json.optJSONObject("data"))
                } else {
                    ApiResult.Fail(
                        message = json?.optString("message")?.takeIf { it.isNotBlank() }
                            ?: "Terjadi kesalahan (HTTP ${response.code})",
                        httpCode = response.code,
                        errors = json?.optJSONObject("errors"),
                    )
                }
            }
        } catch (e: IOException) {
            ApiResult.Fail("Tidak bisa menghubungi server — periksa koneksi internet", 0, null)
        }
    }

    private fun authedBuilder(path: String): Request.Builder {
        val builder = Request.Builder().url("$baseUrl$path")
        sessionStore.accessToken()?.let { builder.addHeader("Authorization", "Bearer $it") }
        return builder.addHeader("Accept", "application/json")
    }

    private fun jsonBody(fields: Map<String, Any?>): okhttp3.RequestBody {
        val json = JSONObject()
        fields.forEach { (key, value) -> json.put(key, value ?: JSONObject.NULL) }
        return json.toString().toRequestBody("application/json".toMediaType())
    }

    private fun emptyBody() = "".toRequestBody()

    // ---- Auth ----

    // `client` hanya dipakai backend untuk menamai token Sanctum, dan nilai
    // yang diterima dibatasi web_dashboard|master_app|telegram_bot -- APK
    // Live satu keluarga dengan APK Master, jadi pakai master_app.
    suspend fun login(username: String, password: String): ApiResult = execute(
        Request.Builder()
            .url("$baseUrl/auth/login")
            .addHeader("Accept", "application/json")
            .post(jsonBody(mapOf("username" to username, "password" to password, "client" to "master_app")))
            .build(),
    )

    suspend fun verifyTwoFactor(challengeToken: String, code: String): ApiResult = execute(
        Request.Builder()
            .url("$baseUrl/auth/2fa/verify")
            .addHeader("Accept", "application/json")
            .post(jsonBody(mapOf("challenge_token" to challengeToken, "code" to code)))
            .build(),
    )

    suspend fun confirmTwoFactorSetup(setupToken: String, code: String): ApiResult = execute(
        Request.Builder()
            .url("$baseUrl/auth/2fa/setup/confirm")
            .addHeader("Accept", "application/json")
            .post(jsonBody(mapOf("setup_token" to setupToken, "code" to code)))
            .build(),
    )

    /** Profil terbaru (izin & aturan Live Kerja); null kalau gagal (pakai profil tersimpan). */
    suspend fun me(): UserProfile? {
        val result = execute(authedBuilder("/auth/me").get().build())
        return (result as? ApiResult.Ok)?.data?.let { runCatching { UserProfile.fromJson(it) }.getOrNull() }
    }

    suspend fun logout(): ApiResult = execute(authedBuilder("/auth/logout").post(emptyBody()).build())

    // ---- Live Kerja ----

    /** Membuka (atau melanjutkan) sesi kerja; data berisi livekit_url, token, room, session. */
    // device=android_app: APK ini membagikan layar + kamera, jadi server
    // mengizinkannya (browser HP & APK lama tanpa layar tetap ditolak).
    suspend fun startLiveSession(): ApiResult =
        execute(authedBuilder("/live/sessions/start").post(jsonBody(mapOf("device" to "android_app"))).build())

    /**
     * Detak sesi + kondisi siaran (kamera & layar menyala? sedang istirahat?)
     * -- server menghitung status kerja dari sini (layar mati = Screen off,
     * istirahat = Break; keduanya tidak dihitung kerja).
     * 404 = server sudah menutup sesi (timeout) -- siaran wajib berhenti.
     */
    suspend fun heartbeatLiveSession(
        cameraActive: Boolean,
        screenActive: Boolean,
        faceMissing: Boolean,
        onBreak: Boolean,
    ): ApiResult = execute(
        authedBuilder("/live/sessions/heartbeat")
            .post(
                jsonBody(
                    mapOf(
                        "camera_active" to cameraActive,
                        "screen_active" to screenActive,
                        "face_missing" to faceMissing,
                        "on_break" to onBreak,
                    ),
                ),
            )
            .build(),
    )

    suspend fun endLiveSession(): ApiResult =
        execute(authedBuilder("/live/sessions/end").post(emptyBody()).build())

    // ---- Peringatan dari atasan (sama dengan WarningPopup.vue di dashboard) ----

    /** Peringatan yang belum dikonfirmasi staf; kosong kalau semua sudah dibaca. */
    suspend fun pendingWarnings(): List<StaffWarning> {
        val result = execute(authedBuilder("/staff-warnings/pending").get().build())
        val items = (result as? ApiResult.Ok)?.data?.optJSONArray("items") ?: return emptyList()
        return (0 until items.length()).mapNotNull { index ->
            val item = items.optJSONObject(index) ?: return@mapNotNull null
            StaffWarning(
                id = item.optInt("id"),
                levelLabel = item.optString("level_label").ifBlank { item.optString("level") },
                level = item.optString("level"),
                message = item.optString("message"),
                issuerName = item.optString("issuer_name").takeIf { it.isNotBlank() && it != "null" },
            )
        }
    }

    suspend fun acknowledgeWarning(id: Int): ApiResult =
        execute(authedBuilder("/staff-warnings/$id/acknowledge").post(emptyBody()).build())
}

data class StaffWarning(
    val id: Int,
    val level: String,
    val levelLabel: String,
    val message: String,
    val issuerName: String?,
)
