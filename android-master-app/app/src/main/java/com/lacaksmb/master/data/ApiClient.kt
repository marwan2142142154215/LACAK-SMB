package com.lacaksmb.master.data

import com.lacaksmb.master.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Hasil satu panggilan API: envelope asli backend {success, message, data|errors}. */
sealed class ApiResult {
    data class Ok(val message: String, val data: JSONObject?) : ApiResult()
    data class Fail(val message: String, val httpCode: Int, val errors: JSONObject?) : ApiResult()
}

/**
 * Klien HTTP tipis ke backend-api (bukan Retrofit — mengikuti pola yang
 * sama dengan tracker app: OkHttp + org.json langsung, supaya kedua APK
 * konsisten dan tidak menambah dependency besar tanpa perlu).
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

    // ---- Auth ----

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

    suspend fun logout(): ApiResult = execute(authedBuilder("/auth/logout").post("".toRequestBody()).build())

    // ---- Devices ----

    suspend fun listDevices(organizationId: Int? = null): ApiResult {
        val qp = organizationId?.let { "?organization_id=$it&per_page=100" } ?: "?per_page=100"
        return execute(authedBuilder("/devices$qp").get().build())
    }

    suspend fun getDevice(deviceId: Int): ApiResult = execute(authedBuilder("/devices/$deviceId").get().build())

    suspend fun sendCommand(deviceId: Int, commandType: String, reasonNote: String?): ApiResult = execute(
        authedBuilder("/devices/$deviceId/commands")
            .post(
                jsonBody(
                    mapOf(
                        "command_type" to commandType,
                        "issued_via" to "master_app",
                        "reason_note" to reasonNote,
                    ),
                ),
            )
            .build(),
    )

    suspend fun generateOtp(deviceId: Int): ApiResult =
        execute(authedBuilder("/devices/$deviceId/otp").post("".toRequestBody()).build())

    // ---- APK builds ----

    /** Memicu build APK sungguhan (tracker/master) di server -- lihat backend-api ApkBuildController::generate(). */
    suspend fun generateApkBuild(organizationId: Int, apkType: String, version: String): ApiResult = execute(
        authedBuilder("/apk-builds/generate")
            .post(
                jsonBody(
                    mapOf(
                        "organization_id" to organizationId,
                        "apk_type" to apkType,
                        "version" to version,
                    ),
                ),
            )
            .build(),
    )

    suspend fun getApkBuild(id: Int): ApiResult = execute(authedBuilder("/apk-builds/$id").get().build())

    // ---- Geofence rules ----

    suspend fun listGeofenceRules(organizationId: Int? = null): ApiResult {
        val qp = organizationId?.let { "?organization_id=$it&per_page=100" } ?: "?per_page=100"
        return execute(authedBuilder("/geofence-rules$qp").get().build())
    }

    suspend fun createGeofenceRule(
        organizationId: Int,
        ruleName: String,
        allowedSsid: String?,
        allowedIpCidr: String?,
        maxDistanceMeters: Int?,
    ): ApiResult = execute(
        authedBuilder("/geofence-rules")
            .post(
                jsonBody(
                    mapOf(
                        "organization_id" to organizationId,
                        "rule_name" to ruleName,
                        "allowed_ssid" to allowedSsid,
                        "allowed_ip_cidr" to allowedIpCidr,
                        "max_distance_meters" to maxDistanceMeters,
                    ),
                ),
            )
            .build(),
    )

    suspend fun updateGeofenceRule(id: Int, isActive: Boolean): ApiResult = execute(
        authedBuilder("/geofence-rules/$id")
            .patch(jsonBody(mapOf("is_active" to isActive)))
            .build(),
    )

    suspend fun deleteGeofenceRule(id: Int): ApiResult =
        execute(authedBuilder("/geofence-rules/$id").delete().build())

    // ---- Consent documents ----

    suspend fun listConsentDocuments(organizationId: Int? = null): ApiResult {
        val qp = organizationId?.let { "?organization_id=$it&per_page=100" } ?: "?per_page=100"
        return execute(authedBuilder("/consent-documents$qp").get().build())
    }

    suspend fun createConsentDocument(
        organizationId: Int,
        subjectName: String,
        signerName: String,
        signerRole: String,
        signedAt: String,
        validUntil: String?,
        documentFile: File,
        documentMimeType: String,
    ): ApiResult {
        val multipart = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("organization_id", organizationId.toString())
            .addFormDataPart("subject_name", subjectName)
            .addFormDataPart("signer_name", signerName)
            .addFormDataPart("signer_role", signerRole)
            .addFormDataPart("signed_at", signedAt)
            .apply { validUntil?.let { addFormDataPart("valid_until", it) } }
            .addFormDataPart(
                "document_file",
                documentFile.name,
                documentFile.asRequestBody(documentMimeType.toMediaType()),
            )
            .build()
        return execute(authedBuilder("/consent-documents").post(multipart).build())
    }

    suspend fun revokeConsentDocument(id: Int): ApiResult =
        execute(authedBuilder("/consent-documents/$id/revoke").post("".toRequestBody()).build())
}
