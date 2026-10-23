package com.lacaksmb.live.service

import io.livekit.android.room.Room
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface BroadcastStatus {
    /** Tidak menyiarkan. [lastError] = alasan siaran terakhir berhenti sendiri (bukan karena tombol). */
    data class Idle(val lastError: String? = null) : BroadcastStatus
    data class Connecting(val message: String) : BroadcastStatus
    data object Live : BroadcastStatus
    data object Stopping : BroadcastStatus
}

/**
 * Jembatan status antara LiveBroadcastService dan layar Compose. Sengaja
 * objek di memori proses (bukan binding service): service-lah satu-satunya
 * pemilik Room LiveKit, layar hanya membaca untuk menampilkan status &
 * pratinjau kamera -- siaran tetap jalan walau Activity sudah dihancurkan.
 */
object LiveBroadcastState {
    private val _status = MutableStateFlow<BroadcastStatus>(BroadcastStatus.Idle())
    val status: StateFlow<BroadcastStatus> = _status.asStateFlow()

    private val _room = MutableStateFlow<Room?>(null)
    /** Room yang sedang tersambung, hanya untuk pratinjau kamera sendiri di layar. */
    val room: StateFlow<Room?> = _room.asStateFlow()

    private val _liveSince = MutableStateFlow<Long?>(null)
    val liveSince: StateFlow<Long?> = _liveSince.asStateFlow()

    internal fun setStatus(status: BroadcastStatus) {
        _status.value = status
        if (status is BroadcastStatus.Idle) _liveSince.value = null
        if (status is BroadcastStatus.Live && _liveSince.value == null) _liveSince.value = System.currentTimeMillis()
    }

    internal fun setRoom(room: Room?) {
        _room.value = room
    }

    fun clearError() {
        val current = _status.value
        if (current is BroadcastStatus.Idle && current.lastError != null) _status.value = BroadcastStatus.Idle()
    }
}
