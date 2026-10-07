package com.lacaksmb.tracker.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.lacaksmb.tracker.data.DeviceIdentityStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Auto-start pemantauan setelah device reboot, TAPI hanya kalau device ini
 * memang sudah pernah di-enroll — bukan auto-start tanpa izin pada device
 * yang belum pernah disetujui.
 */
class BootCompletedReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val pendingResult = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val store = DeviceIdentityStore(context.applicationContext)
                val snapshot = store.snapshot()
                if (snapshot.isEnrolled) {
                    TrackerForegroundService.start(context.applicationContext)
                }
            } finally {
                pendingResult.finish()
            }
        }
    }
}
