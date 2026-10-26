package com.lacaksmb.live.service

import io.livekit.android.room.Room
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Mikrofon siaran: tersiar, dibisukan staf, atau tidak ada (izin ditolak / gagal dibuka). */
enum class MicState { On, Muted, None }

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

    private val _micState = MutableStateFlow(MicState.None)
    val micState: StateFlow<MicState> = _micState.asStateFlow()

    private val _screenSharing = MutableStateFlow(false)
    /** Layar HP sedang dibagikan (MediaProjection aktif & track layar terbit). */
    val screenSharing: StateFlow<Boolean> = _screenSharing.asStateFlow()

    private val _faceMissing = MutableStateFlow(false)
    /** Tidak ada wajah di kamera >= 30 detik (hanya dicatat, jam kerja tetap dihitung). */
    val faceMissing: StateFlow<Boolean> = _faceMissing.asStateFlow()

    private val _liveSince = MutableStateFlow<Long?>(null)
    val liveSince: StateFlow<Long?> = _liveSince.asStateFlow()

    internal fun setStatus(status: BroadcastStatus) {
        _status.value = status
        if (status is BroadcastStatus.Idle) _liveSince.value = null
        if (status is BroadcastStatus.Live && _liveSince.value == null) _liveSince.value = System.currentTimeMillis()
    }

    internal fun setRoom(room: Room?) {
        _room.value = room
        if (room == null) {
            _micState.value = MicState.None
            _screenSharing.value = false
            _faceMissing.value = false
        }
    }

    internal fun setFaceMissing(missing: Boolean) {
        _faceMissing.value = missing
    }

    internal fun setScreenSharing(sharing: Boolean) {
        _screenSharing.value = sharing
    }

    internal fun setMicState(state: MicState) {
        _micState.value = state
    }

    fun clearError() {
        val current = _status.value
        if (current is BroadcastStatus.Idle && current.lastError != null) _status.value = BroadcastStatus.Idle()
    }
}
