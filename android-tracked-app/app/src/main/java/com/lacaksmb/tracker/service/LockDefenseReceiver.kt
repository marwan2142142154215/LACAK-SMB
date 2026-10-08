package com.lacaksmb.tracker.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver
import com.lacaksmb.tracker.data.DeviceLockStore
import com.lacaksmb.tracker.ui.LockActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Pertahanan lock jarak jauh (anti-skip). Selama device berada dalam status
 * "dikunci admin" — yang TERSIMPAN PERSISTEN di DeviceLockStore, bukan cuma
 * state sementara — receiver ini memastikan device TIDAK bisa dipakai:
 *
 *  - ACTION_SCREEN_ON    → layar dinyalakan user; pasang ulang LockActivity
 *    (screen pinning) kalau status masih locked.
 *  - ACTION_USER_PRESENT → keyguard BARU SAJA dilewati user. Kalau status
 *    masih locked, LockActivity dibuka LAGI (task baru, exclude-from-recents)
 *    supaya device tidak pernah sampai ke launcher/app lain selama locked;
 *    kalau untuk suatu alasan activity tidak bisa dibuka, kunci LAGI seketika
 *    via lockNow() sebagai jaring pengaman minimum.
 *
 * PENTING: lockNow() (Device Admin) TIDAK dipanggil kalau LockActivity
 * berhasil dibuka — lockNow() benar-benar mematikan layar seperti tombol
 * power (lalu minta PIN/pola device kalau sudah di-set). Memanggilnya
 * bareng LockActivity (yang menyalakan layar lagi lewat setTurnScreenOn)
 * menyebabkan layar hidup-mati-hidup-mati berulang — bug yang pernah
 * terjadi di sini. lockNow() hanya jadi fallback TERAKHIR kalau activity
 * benar-benar gagal dibuka.
 *
 * Reboot ditangani BootCompletedReceiver (menghidupkan service); service itu
 * sendiri membuka ulang LockActivity dari DeviceLockStore saat start.
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

                try {
                    LockActivity.launch(appContext, lock.reason)
                } catch (_: Exception) {
                    TrackerDeviceAdminReceiver.lockNow(appContext)
                }
            } finally {
                pendingResult.finish()
            }
        }
    }
}