package com.lacaksmb.master.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject

/**
 * Menyimpan Sanctum access_token & profil user yang sedang login.
 * Dienkripsi (EncryptedSharedPreferences) karena access_token adalah
 * kredensial asli yang bisa dipakai memanggil API atas nama admin —
 * beda dari DeviceIdentityStore di tracker app yang isinya bukan rahasia.
 */
class SessionStore(context: Context) {

    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "master_session",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun saveSession(accessToken: String, user: UserProfile) {
        prefs.edit()
            .putString(KEY_TOKEN, accessToken)
            .putString(KEY_USER, user.toJson().toString())
            .apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    fun accessToken(): String? = prefs.getString(KEY_TOKEN, null)

    fun user(): UserProfile? {
        val raw = prefs.getString(KEY_USER, null) ?: return null
        return UserProfile.fromJson(JSONObject(raw))
    }

    fun isLoggedIn(): Boolean = !accessToken().isNullOrBlank()

    companion object {
        private const val KEY_TOKEN = "access_token"
        private const val KEY_USER = "user_profile"
    }
}

data class UserProfile(
    val id: Int,
    val username: String,
    val name: String,
    val email: String,
    val organizationId: Int?,
    val roles: List<String>,
    val permissions: List<String>,
) {
    fun can(permission: String): Boolean = permissions.contains(permission)

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("username", username)
        put("name", name)
        put("email", email)
        put("organization_id", organizationId)
        put("roles", JSONArray(roles))
        put("permissions", JSONArray(permissions))
    }

    companion object {
        fun fromJson(json: JSONObject): UserProfile {
            val rolesArray = json.optJSONArray("roles") ?: JSONArray()
            val permsArray = json.optJSONArray("permissions") ?: JSONArray()
            return UserProfile(
                id = json.optInt("id"),
                username = json.optString("username"),
                name = json.optString("name"),
                email = json.optString("email"),
                organizationId = if (json.isNull("organization_id")) null else json.optInt("organization_id"),
                roles = (0 until rolesArray.length()).map { rolesArray.getString(it) },
                permissions = (0 until permsArray.length()).map { permsArray.getString(it) },
            )
        }
    }
}
