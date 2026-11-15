package com.lacaksmb.tracker.admin

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import com.lacaksmb.tracker.BuildConfig
import com.lacaksmb.tracker.data.DeviceIdentityStore
import com.lacaksmb.tracker.service.ServiceWatchdogWorker
import com.lacaksmb.tracker.service.TrackerForegroundService
import kotlinx.coroutines.runBlocking

/**
 * Dua layar wajib untuk QR provisioning Device Owner di Android 10+ (wajib mulai Android 12).
 * Keduanya dipanggil oleh wizard penyiapan Android SAJA (dilindungi BIND_DEVICE_ADMIN di
 * manifest), tidak punya tampilan, dan langsung selesai.
 */

/** Wizard penyiapan bertanya mode apa yang diinginkan: selalu HP terkelola penuh (aset perusahaan). */
class ProvisioningModeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            setResult(
                RESULT_OK,
                Intent().putExtra(
                    DevicePolicyManager.EXTRA_PROVISIONING_MODE,
                    DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE,
                ),
            )
        } else {
            setResult(RESULT_CANCELED)
        }
        finish()
    }
}

/**
 * Dipanggil setelah app menjadi Device Owner, sebelum wizard penyiapan selesai: beri izin yang
 * dibutuhkan, tandai pendaftaran (identitas device sudah tertanam saat build), lalu mulai service.
 */
class PolicyComplianceActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        completeDeviceOwnerSetup(this)
        setResult(RESULT_OK)
        finish()
    }
}

/** Dipakai PolicyComplianceActivity dan TrackerDeviceAdminReceiver.onProfileProvisioningComplete. */
internal fun completeDeviceOwnerSetup(context: android.content.Context) {
    val appContext = context.applicationContext
    if (!DeviceOwnerSetup.applyIfDeviceOwner(appContext)) return
    // DataStore cepat (file lokal kecil); dijalankan sinkron karena layar ini harus segera selesai.
    runBlocking {
        val store = DeviceIdentityStore(appContext)
        store.ensureDeviceUuid()
        store.ensureDeviceSecretFromBuild()
        store.saveEnrollment(BuildConfig.SITE_CODE, BuildConfig.GATEWAY_URL)
    }
    ServiceWatchdogWorker.schedule(appContext)
    TrackerForegroundService.startSafely(appContext)
}
