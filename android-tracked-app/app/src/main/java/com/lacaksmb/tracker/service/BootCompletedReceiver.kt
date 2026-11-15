package com.lacaksmb.tracker.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.lacaksmb.tracker.admin.DeviceOwnerSetup
import com.lacaksmb.tracker.data.DeviceIdentityStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Auto-start pemantauan setelah HP dinyalakan ulang ATAU APK diperbarui, TAPI hanya kalau device
 * ini memang sudah pernah di-enroll — bukan auto-start tanpa izin pada device yang belum disetujui.
 *
 * - BOOT_COMPLETED: HP selesai menyala.
 * - QUICKBOOT_POWERON: varian "fast boot" sebagian merek (HTC, Xiaomi lama, dll.).
 * - MY_PACKAGE_REPLACED: APK baru dipasang menimpa versi lama -- tanpa ini service mati sampai
 *   app dibuka manual atau HP dinyalakan ulang.
 *
 * Perintah lock yang dikirim saat HP mati tetap menunggu di server dan dikirim begitu service
 * tersambung lagi; status kunci lokal (DeviceLockStore) juga langsung ditegakkan ulang oleh service.
 */
class BootCompletedReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in HANDLED_ACTIONS) return

        val pendingResult = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val appContext = context.applicationContext
                DeviceOwnerSetup.applyIfDeviceOwner(appContext)
                val snapshot = DeviceIdentityStore(appContext).snapshot()
                if (snapshot.isEnrolled) {
                    ServiceWatchdogWorker.schedule(appContext)
                    TrackerForegroundService.startSafely(appContext)
                }
            } finally {
                pendingResult.finish()
            }
        }
    }

    companion object {
        private val HANDLED_ACTIONS = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON",
        )
    }
}
