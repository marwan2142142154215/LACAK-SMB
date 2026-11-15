package com.lacaksmb.tracker.service

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Status koneksi service untuk ditampilkan di layar APK (MainActivity) -- teks yang sama dengan
 * notifikasi pemantauan, supaya pemegang HP & teknisi melihat langsung "Terhubung" / "Menunggu
 * pendaftaran" / "Terputus" tanpa membuka notifikasi.
 */
object TrackerStatus {
    private val mutableText = MutableStateFlow("Belum berjalan")
    val text: StateFlow<String> = mutableText.asStateFlow()

    private val mutableConnected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = mutableConnected.asStateFlow()

    fun update(status: String, isConnected: Boolean? = null) {
        mutableText.value = status
        if (isConnected != null) mutableConnected.value = isConnected
    }
}
