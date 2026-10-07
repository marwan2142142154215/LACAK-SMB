package com.lacaksmb.tracker.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings
import com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver
import com.lacaksmb.tracker.data.DeviceLockStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Pertahanan lock jarak jauh (anti-skip). Selama device berada dalam status
 * "dikunci admin" — yang TERSIMPAN PERSISTEN di DeviceLockStore, bukan cuma
 * state sementara — receiver ini memastikan device TIDAK bisa dipakai:
 *
 *  - ACTION_SCREEN_ON       → layar dinyalakan user; pastikan penegakan lock
 *    masih aktif (overlay peringatan / kunci ulang).
 *  - ACTION_USER_PRESENT    → keyguard BARU SAJA dilewati user. Kalau status
 *    masih locked:
 *      • izin overlay ada → service dipanggil untuk memasang ulang lapisan
 *        peringatan (layar terkunci visual + dijaga oleh kunci ulang tertunda);
 *      • izin overlay tidak ada → kunci LAGI seketika via lockNow() — membuka
 *        paksa = layar langsung mati kembali. Tidak ada "skip".
 *
 * Reboot ditangani BootCompletedReceiver (menghidupkan service); service itu
 * sendiri menampilkan ulang lapisan peringatan dari DeviceLockStore saat start.
 */
class LockDefenseReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_SCREEN_ON && action != Intent.ACTION_USER_PRESENT) return

        val pendingResult = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val appContext = context.applicationContext
                val lock = DeviceLockStore(appContext).snapshot()
                if (!lock.adminLocked) return@launch

                if (Settings.canDrawOverlays(appContext)) {
                    // Service sudah berjalan sebagai foreground (app dianggap
                    // "foreground state"), jadi startService aman — pasang
                    // ulang lapisan peringatan + kunci ulang tertunda.
                    try {
                        appContext.startService(
                            Intent(appContext, TrackerForegroundService::class.java)
                                .setAction(TrackerForegroundService.ACTION_ENSURE_LOCKED_OVERLAY),
                        )
                    } catch (_: Exception) {
                        // Service tidak bisa di-start dari background — kunci
                        // seketika sebagai penegakan minimum.
                        TrackerDeviceAdminReceiver.lockNow(appContext)
                    }
                } else {
                    TrackerDeviceAdminReceiver.lockNow(appContext)
                }
            } finally {
                pendingResult.finish()
            }
        }
    }
}