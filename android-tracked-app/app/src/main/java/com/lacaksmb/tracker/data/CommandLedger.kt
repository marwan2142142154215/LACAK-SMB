package com.lacaksmb.tracker.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

private val Context.commandLedgerStore by preferencesDataStore(name = "command_ledger")

/**
 * Catatan perintah yang SUDAH dijalankan HP ini (id + hasil). Gateway mengirim ulang perintah yang
 * belum dikonfirmasi (socket bisa putus tepat setelah perintah diterima); dengan catatan ini
 * perintah yang sama tidak dijalankan dua kali -- HP cukup mengirim ulang hasil yang tersimpan.
 * Persisten supaya tetap berlaku setelah HP dinyalakan ulang.
 */
class CommandLedger(private val context: Context) {

    data class Entry(val commandId: Int, val result: String, val message: String?)

    private val key = stringPreferencesKey("entries")

    suspend fun find(commandId: Int): Entry? = entries().firstOrNull { it.commandId == commandId }

    suspend fun record(entry: Entry) {
        context.commandLedgerStore.edit { prefs ->
            val kept = parse(prefs[key]).filterNot { it.commandId == entry.commandId }
                .takeLast(MAX_ENTRIES - 1) + entry
            prefs[key] = JSONArray().apply {
                kept.forEach { item ->
                    put(
                        JSONObject().apply {
                            put("id", item.commandId)
                            put("result", item.result)
                            item.message?.let { put("message", it) }
                        },
                    )
                }
            }.toString()
        }
    }

    private suspend fun entries(): List<Entry> = parse(context.commandLedgerStore.data.first()[key])

    private fun parse(raw: String?): List<Entry> {
        if (raw.isNullOrBlank()) return emptyList()
        return try {
            val array = JSONArray(raw)
            (0 until array.length()).mapNotNull { index ->
                val item = array.optJSONObject(index) ?: return@mapNotNull null
                Entry(
                    commandId = item.optInt("id"),
                    result = item.optString("result"),
                    message = if (item.has("message")) item.optString("message") else null,
                )
            }
        } catch (_: JSONException) {
            emptyList()
        }
    }

    companion object {
        private const val MAX_ENTRIES = 50
    }
}
