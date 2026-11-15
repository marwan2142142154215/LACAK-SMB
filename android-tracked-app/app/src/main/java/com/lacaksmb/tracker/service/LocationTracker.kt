package com.lacaksmb.tracker.service

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import android.util.Log
import com.lacaksmb.tracker.setup.SetupChecks
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Sumber posisi untuk heartbeat & perintah locate_now. Mendengarkan GPS DAN jaringan (cadangan
 * di dalam ruangan / saat GPS belum fix), lalu memilih fix terbaik: yang lebih baru menang kalau
 * selisihnya jauh, kalau berdekatan yang lebih akurat menang.
 *
 * Memakai LocationManager (bukan Google Play Services) supaya tetap jalan di HP tanpa GMS.
 */
class LocationTracker(context: Context) {

    private val appContext = context.applicationContext
    private val lm = appContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager

    @Volatile
    private var best: Location? = null
    private var started = false

    // Semua metode di-override eksplisit: di Android 10 ke bawah onStatusChanged/onProviderEnabled
    // /onProviderDisabled BELUM punya implementasi default di interface framework -- kalau tidak
    // di-override, sistem memanggil metode abstrak dan app crash (AbstractMethodError).
    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            consider(location)
        }

        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
        override fun onProviderEnabled(provider: String) = Unit
        override fun onProviderDisabled(provider: String) = Unit
    }

    @SuppressLint("MissingPermission")
    fun start() {
        if (started || !SetupChecks.hasForegroundLocation(appContext)) return
        started = true
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            try {
                if (lm.allProviders.contains(provider)) {
                    lm.requestLocationUpdates(
                        provider,
                        UPDATE_INTERVAL_MS,
                        UPDATE_MIN_DISTANCE_M,
                        listener,
                        Looper.getMainLooper(),
                    )
                }
            } catch (e: SecurityException) {
                Log.w(TAG, "izin lokasi dicabut, $provider tidak bisa dipakai: ${e.message}")
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "provider $provider tidak tersedia: ${e.message}")
            }
        }
    }

    fun stop() {
        if (!started) return
        started = false
        try {
            lm.removeUpdates(listener)
        } catch (e: SecurityException) {
            Log.w(TAG, "removeUpdates lokasi gagal: ${e.message}")
        }
    }

    /** Fix terbaik yang diketahui (dari pembaruan, atau last-known kalau belum ada pembaruan). */
    @SuppressLint("MissingPermission")
    fun current(): Location? {
        if (best == null && SetupChecks.hasForegroundLocation(appContext)) {
            for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)) {
                try {
                    lm.getLastKnownLocation(provider)?.let { consider(it) }
                } catch (_: SecurityException) {
                    return null
                } catch (_: IllegalArgumentException) {
                    // Provider tidak ada di HP ini.
                }
            }
        }
        return best
    }

    /**
     * Minta fix BARU (perintah locate_now): dengarkan GPS + jaringan sampai dapat posisi yang cukup
     * akurat atau batas waktu habis. Mengembalikan fix terbaik yang didapat selama menunggu, atau
     * null kalau tidak ada sama sekali (pemanggil lalu memakai current() sebagai cadangan).
     */
    @SuppressLint("MissingPermission")
    suspend fun freshFix(timeoutMs: Long): Location? = withContext(Dispatchers.Main) {
        if (!SetupChecks.hasForegroundLocation(appContext)) return@withContext null
        val requestedAt = System.currentTimeMillis()
        var bestDuringWait: Location? = null
        val goodEnough = CompletableDeferred<Location>()
        val oneShot = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                consider(location)
                val sofar = bestDuringWait
                if (sofar == null || isBetter(location, sofar)) bestDuringWait = location
                if (location.hasAccuracy() && location.accuracy <= GOOD_ACCURACY_M) {
                    goodEnough.complete(location)
                }
            }

            @Deprecated("Deprecated in Java")
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
            override fun onProviderEnabled(provider: String) = Unit
            override fun onProviderDisabled(provider: String) = Unit
        }
        try {
            for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
                try {
                    if (lm.allProviders.contains(provider) && lm.isProviderEnabled(provider)) {
                        lm.requestLocationUpdates(provider, 0L, 0f, oneShot, Looper.getMainLooper())
                    }
                } catch (e: IllegalArgumentException) {
                    Log.w(TAG, "provider $provider tidak tersedia: ${e.message}")
                }
            }
            withTimeoutOrNull(timeoutMs) { goodEnough.await() } ?: bestDuringWait
        } catch (e: SecurityException) {
            Log.w(TAG, "izin lokasi dicabut saat locate_now: ${e.message}")
            null
        } finally {
            try {
                lm.removeUpdates(oneShot)
            } catch (_: SecurityException) {
                // Izin sudah dicabut -- listener otomatis tidak aktif.
            }
            Log.i(TAG, "freshFix selesai dalam ${System.currentTimeMillis() - requestedAt} ms")
        }
    }

    private fun consider(location: Location) {
        val current = best
        if (current == null || isBetter(location, current)) best = location
    }

    companion object {
        private const val TAG = "LocationTracker"
        private const val UPDATE_INTERVAL_MS = 30_000L
        private const val UPDATE_MIN_DISTANCE_M = 5f

        /** Fix dengan radius akurasi ini atau lebih kecil dianggap cukup untuk locate_now. */
        private const val GOOD_ACCURACY_M = 50f

        /** Selisih waktu yang membuat fix lebih baru selalu menang (atau lebih lama selalu kalah). */
        private const val SIGNIFICANT_AGE_MS = 2 * 60 * 1000L

        /** Pola resmi Android "Location strategies": waktu dulu, lalu akurasi. */
        fun isBetter(candidate: Location, current: Location): Boolean {
            val timeDelta = candidate.time - current.time
            if (timeDelta > SIGNIFICANT_AGE_MS) return true
            if (timeDelta < -SIGNIFICANT_AGE_MS) return false
            val candidateAccuracy = if (candidate.hasAccuracy()) candidate.accuracy else Float.MAX_VALUE
            val currentAccuracy = if (current.hasAccuracy()) current.accuracy else Float.MAX_VALUE
            if (candidateAccuracy < currentAccuracy) return true
            if (timeDelta > 0 && candidateAccuracy <= currentAccuracy + 50f) return true
            return false
        }
    }
}
