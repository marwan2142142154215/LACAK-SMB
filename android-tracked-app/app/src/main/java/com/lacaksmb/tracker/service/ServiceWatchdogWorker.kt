package com.lacaksmb.tracker.service

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.lacaksmb.tracker.data.DeviceIdentityStore
import java.util.concurrent.TimeUnit

/**
 * Jaring pengaman "selalu online": tiap 15 menit (batas minimum WorkManager) pastikan foreground
 * service pemantauan hidup. Beberapa merek HP (Xiaomi, Oppo, Vivo, dll.) mematikan service app
 * di latar belakang walau sudah foreground; WorkManager dijadwalkan ulang oleh sistem sendiri,
 * termasuk setelah HP dinyalakan ulang. Memulai service yang sudah jalan tidak berefek apa pun.
 */
class ServiceWatchdogWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        if (DeviceIdentityStore(applicationContext).snapshot().isEnrolled) {
            TrackerForegroundService.startSafely(applicationContext)
        }
        return Result.success()
    }

    companion object {
        private const val WORK_NAME = "tracker-service-watchdog"

        fun schedule(context: Context) {
            WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<ServiceWatchdogWorker>(15, TimeUnit.MINUTES).build(),
            )
        }

        /** Perangkat dilepas: berhenti menyalakan ulang service pemantauan. */
        fun cancel(context: Context) {
            WorkManager.getInstance(context.applicationContext).cancelUniqueWork(WORK_NAME)
        }
    }
}
