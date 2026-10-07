package com.lacaksmb.tracker.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first

private val Context.lockDataStore by preferencesDataStore(name = "lock_state")

/**
 * Status kunci-jarak-jauh yang PERSISTEN di device. Ditulis saat perintah
 * `lock` diterima dari server dan dihapus saat `unlock`. Tidak bergantung
 * pada service yang sedang hidup, sehingga kunci tetap berlaku setelah
 * reboot / service di-restart oleh sistem (anti-"skip": user tidak bisa
 * menonaktifkan kunci hanya dengan menutup app).
 */
class DeviceLockStore(private val context: Context) {

    private object Keys {
        val ADMIN_LOCKED = booleanPreferencesKey("admin_locked")
        val LOCK_REASON = stringPreferencesKey("lock_reason")
        val LOCKED_AT = longPreferencesKey("locked_at")
    }

    suspend fun setLocked(reason: String?) {
        context.lockDataStore.edit { prefs ->
            prefs[Keys.ADMIN_LOCKED] = true
            prefs[Keys.LOCK_REASON] = reason.orEmpty()
            prefs[Keys.LOCKED_AT] = System.currentTimeMillis()
        }
    }

    suspend fun clear() {
        context.lockDataStore.edit { prefs ->
            prefs[Keys.ADMIN_LOCKED] = false
            prefs.remove(Keys.LOCK_REASON)
            prefs.remove(Keys.LOCKED_AT)
        }
    }

    suspend fun snapshot(): DeviceLockSnapshot {
        val prefs = context.lockDataStore.data.first()
        return DeviceLockSnapshot(
            adminLocked = prefs[Keys.ADMIN_LOCKED] ?: false,
            reason = prefs[Keys.LOCK_REASON] ?: "",
            lockedAt = prefs[Keys.LOCKED_AT] ?: 0L,
        )
    }
}

data class DeviceLockSnapshot(
    val adminLocked: Boolean,
    val reason: String,
    val lockedAt: Long,
)