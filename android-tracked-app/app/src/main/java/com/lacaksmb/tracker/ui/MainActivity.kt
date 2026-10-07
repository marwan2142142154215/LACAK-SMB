package com.lacaksmb.tracker.ui

import android.annotation.SuppressLint
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.lifecycleScope
import com.lacaksmb.tracker.BuildConfig
import com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver
import com.lacaksmb.tracker.data.DeviceIdentityStore
import com.lacaksmb.tracker.service.TrackerForegroundService
import com.lacaksmb.tracker.ui.theme.LacakTrackerTheme
import kotlinx.coroutines.launch

/**
 * Layar ini SENGAJA tidak punya input teks sama sekali (kode site & alamat
 * gateway ditanam saat build lewat BuildConfig — lihat app/build.gradle.kts
 * dan scripts/build-for-site.sh). Staf hanya menekan tombol izin yang
 * muncul; begitu semua langkah selesai, pemantauan mulai otomatis.
 *
 * Catatan platform Android (bukan keterbatasan desain): app yang BARU
 * diinstal berada dalam "stopped state" dan tidak akan menerima broadcast
 * apa pun (termasuk BOOT_COMPLETED) sampai dibuka minimal sekali secara
 * manual. Setelah dibuka sekali & langkah izin ini selesai, service akan
 * auto-restart selamanya (termasuk setelah reboot) tanpa perlu dibuka lagi
 * — lihat BootCompletedReceiver.
 */
class MainActivity : ComponentActivity() {

    private lateinit var identityStore: DeviceIdentityStore

    // State step ditaruh di luar Compose supaya tidak hilang saat Activity
    // di-pause ketika user pergi ke halaman Settings (background location,
    // battery optimization) lalu kembali.
    private var pendingStep by mutableStateOf(EnrollmentStep.RUNTIME_PERMISSIONS)
    private var statusText by mutableStateOf("")

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        // Lokasi WAJIB diizinkan — foreground service bertipe "location"
        // akan SecurityException saat start kalau tidak ada izin lokasi
        // sama sekali. Bluetooth/notifikasi boleh ditolak (fitur terkait
        // nonaktif, tapi service tetap bisa jalan untuk heartbeat & command).
        val locationGranted = results[android.Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            results[android.Manifest.permission.ACCESS_COARSE_LOCATION] == true

        if (!locationGranted) {
            statusText = "Izin lokasi wajib diberikan supaya pemantauan bisa jalan. Tekan Mulai untuk coba lagi."
            pendingStep = EnrollmentStep.RUNTIME_PERMISSIONS
            return@registerForActivityResult
        }

        advanceFrom(EnrollmentStep.RUNTIME_PERMISSIONS)
    }

    private val deviceAdminLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        // Jangan percaya begitu saja hasil intent: verifikasi ke sistem bahwa
        // komponen Device Admin BENAR-BENAR aktif (user bisa saja membatalkan
        // dialog "Aktifkan aplikasi admin perangkat").
        val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (dpm.isAdminActive(TrackerDeviceAdminReceiver.componentName(this))) {
            advanceFrom(EnrollmentStep.DEVICE_ADMIN)
        } else {
            statusText = "Kemampuan lock jarak jauh belum diaktifkan. Tekan Coba Lagi dan pilih \"Aktifkan\"."
            canRetry = true
        }
    }

    // Menampilkan tombol "Coba Lagi" saat langkah terhenti karena user menolak
    // atau menutup dialog sistem (alih-alih berlanjut diam-diam seperti
    // sebelumnya yang membuat fitur lock tidak jalan tanpa disadari).
    private var canRetry by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        identityStore = DeviceIdentityStore(applicationContext)

        setContent {
            LacakTrackerTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    EnrollmentScreen(
                        identityStore = identityStore,
                        step = pendingStep,
                        statusText = statusText,
                        canRetry = canRetry,
                        onBegin = { runStep(EnrollmentStep.RUNTIME_PERMISSIONS) },
                        onRetry = { runStep(pendingStep) },
                        onAlreadyEnrolled = { TrackerForegroundService.start(applicationContext) },
                    )
                }
            }
        }

        // Deteksi kembali dari halaman Settings (background location /
        // battery optimization) untuk otomatis lanjut ke langkah berikutnya
        // tanpa staf perlu tap tombol lagi di app ini.
        val lifecycleOwner = this
        lifecycleOwner.lifecycle.addObserver(
            LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_RESUME) {
                    when (pendingStep) {
                        EnrollmentStep.BACKGROUND_LOCATION -> {
                            if (backgroundLocationGranted()) {
                                advanceFrom(EnrollmentStep.BACKGROUND_LOCATION)
                            } else {
                                statusText = "Izin lokasi \"selalu\" belum diberikan. Buka Setelan, pilih Lokasi → Izinkan semua waktu, lalu tekan Coba Lagi."
                                canRetry = true
                            }
                        }

                        EnrollmentStep.BATTERY_EXEMPTION -> {
                            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                            if (pm.isIgnoringBatteryOptimizations(packageName)) {
                                advanceFrom(EnrollmentStep.BATTERY_EXEMPTION)
                            } else {
                                statusText = "Pengecualian baterai belum disetujui. Tekan Coba Lagi lalu pilih \"Izinkan\"."
                                canRetry = true
                            }
                        }

                        else -> Unit
                    }
                }
            },
        )
    }

    /** Android 10+ mewajibkan izin lokasi latar belakang terpisah; sebelumnya dianggap ikut lokasi foreground. */
    private fun backgroundLocationGranted(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true
        return checkSelfPermission(android.Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
    }

    /** Dipanggil begitu staf menekan tombol "Mulai" — merantai semua langkah otomatis. */
    private fun runStep(step: EnrollmentStep) {
        pendingStep = step
        canRetry = false
        when (step) {
            EnrollmentStep.RUNTIME_PERMISSIONS -> {
                statusText = "Meminta izin lokasi, Bluetooth & notifikasi..."
                val permissions = mutableListOf(
                    android.Manifest.permission.ACCESS_FINE_LOCATION,
                    android.Manifest.permission.ACCESS_COARSE_LOCATION,
                )
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    permissions += android.Manifest.permission.BLUETOOTH_SCAN
                    permissions += android.Manifest.permission.BLUETOOTH_CONNECT
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    permissions += android.Manifest.permission.POST_NOTIFICATIONS
                }
                permissionLauncher.launch(permissions.toTypedArray())
            }

            EnrollmentStep.BACKGROUND_LOCATION -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                    // Sebelum Android 10, lokasi latar belakang ikut lokasi biasa.
                    advanceFrom(EnrollmentStep.BACKGROUND_LOCATION)
                    return
                }
                statusText = "Buka Setelan untuk pilih \"Izinkan selalu\" pada lokasi..."
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", packageName, null)
                }
                startActivity(intent)
            }

            EnrollmentStep.DEVICE_ADMIN -> {
                statusText = "Mengaktifkan kemampuan lock jarak jauh..."
                val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
                    putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, TrackerDeviceAdminReceiver.componentName(this@MainActivity))
                    putExtra(
                        DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                        "Diperlukan supaya admin bisa mengunci layar device ini dari jarak jauh sesuai persetujuan yang berlaku.",
                    )
                }
                deviceAdminLauncher.launch(intent)
            }

            EnrollmentStep.BATTERY_EXEMPTION -> {
                statusText = "Mengecualikan dari optimisasi baterai..."
                requestBatteryOptimizationExemption()
            }

            EnrollmentStep.STARTING -> startMonitoring()

            EnrollmentStep.ACTIVE -> Unit
        }
    }

    private fun advanceFrom(completedStep: EnrollmentStep) {
        if (pendingStep != completedStep) return // hasil nyasar dari step lama, abaikan
        val next = completedStep.next()
        runStep(next)
    }

    private fun startMonitoring() {
        statusText = "Menyimpan konfigurasi & memulai pemantauan..."
        lifecycleScope.launch {
            identityStore.saveEnrollment(BuildConfig.SITE_CODE, BuildConfig.GATEWAY_URL)
            TrackerForegroundService.start(applicationContext)
            pendingStep = EnrollmentStep.ACTIVE
            statusText = "Aktif memantau untuk site ${BuildConfig.SITE_NAME}."
        }
    }

    @SuppressLint("BatteryLife")
    private fun requestBatteryOptimizationExemption() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            advanceFrom(EnrollmentStep.BATTERY_EXEMPTION)
            return
        }
        val intent = Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:$packageName"),
        )
        startActivity(intent)
    }
}

private enum class EnrollmentStep {
    RUNTIME_PERMISSIONS,
    BACKGROUND_LOCATION,
    DEVICE_ADMIN,
    BATTERY_EXEMPTION,
    STARTING,
    ACTIVE,
    ;

    fun next(): EnrollmentStep = entries.getOrElse(ordinal + 1) { ACTIVE }
}

@Composable
private fun EnrollmentScreen(
    identityStore: DeviceIdentityStore,
    step: EnrollmentStep,
    statusText: String,
    canRetry: Boolean,
    onBegin: () -> Unit,
    onRetry: () -> Unit,
    onAlreadyEnrolled: () -> Unit,
) {
    var deviceUuid by remember { mutableStateOf("") }
    var alreadyEnrolled by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    DisposableEffect(Unit) {
        scope.launch {
            deviceUuid = identityStore.ensureDeviceUuid()
            val snapshot = identityStore.snapshot()
            alreadyEnrolled = snapshot.isEnrolled
            // Jaga-jaga: kalau device sudah pernah di-enroll tapi service
            // entah kenapa tidak jalan (mis. sempat di-force-stop manual),
            // pastikan tetap/kembali jalan tiap app dibuka.
            if (snapshot.isEnrolled) onAlreadyEnrolled()
        }
        onDispose {}
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Lacak SMB", style = MaterialTheme.typography.headlineMedium)
        Text("Site: ${BuildConfig.SITE_NAME}", style = MaterialTheme.typography.titleMedium)
        Text(
            "Aplikasi pelacak resmi. Pendaftaran device hanya sah dengan dokumen consent yang berlaku.",
            style = MaterialTheme.typography.bodyMedium,
        )

        Text("ID Device:", style = MaterialTheme.typography.labelMedium)
        Text(deviceUuid.ifBlank { "Memuat..." }, style = MaterialTheme.typography.bodySmall)

        if (alreadyEnrolled && step == EnrollmentStep.RUNTIME_PERMISSIONS) {
            Text("Device ini sudah terdaftar dan sedang dipantau.", style = MaterialTheme.typography.bodyLarge)
        } else {
            StepRow("Lokasi, Bluetooth & notifikasi", step >= EnrollmentStep.BACKGROUND_LOCATION, step == EnrollmentStep.RUNTIME_PERMISSIONS)
            StepRow("Izin lokasi \"selalu\"", step >= EnrollmentStep.DEVICE_ADMIN, step == EnrollmentStep.BACKGROUND_LOCATION)
            StepRow("Kemampuan lock jarak jauh", step >= EnrollmentStep.BATTERY_EXEMPTION, step == EnrollmentStep.DEVICE_ADMIN)
            StepRow("Pengecualian baterai", step >= EnrollmentStep.STARTING, step == EnrollmentStep.BATTERY_EXEMPTION)

            if (statusText.isNotBlank()) {
                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (step != EnrollmentStep.ACTIVE && step != EnrollmentStep.RUNTIME_PERMISSIONS) {
                        CircularProgressIndicator(modifier = Modifier.padding(end = 4.dp))
                    }
                    Text(statusText, style = MaterialTheme.typography.bodyMedium)
                }
            }

            if (step == EnrollmentStep.RUNTIME_PERMISSIONS) {
                androidx.compose.material3.Button(onClick = onBegin, modifier = Modifier.fillMaxWidth()) {
                    Text(if (statusText.isBlank()) "Mulai" else "Coba Lagi")
                }
            } else if (canRetry && step != EnrollmentStep.ACTIVE && step != EnrollmentStep.STARTING) {
                // Langkah sistem ditolak/dibatalkan user — tawarkan ulang alih-alih
                // berlanjut diam-diam dengan fitur yang tidak benar-benar aktif.
                androidx.compose.material3.Button(onClick = onRetry, modifier = Modifier.fillMaxWidth()) {
                    Text("Coba Lagi")
                }
            }
        }
    }
}

@Composable
private fun StepRow(label: String, done: Boolean, inProgress: Boolean) {
    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            if (done) "✓" else "○",
            style = MaterialTheme.typography.titleMedium,
            color = if (done) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
        )
        Text(
            label,
            style = if (inProgress) MaterialTheme.typography.bodyLarge else MaterialTheme.typography.bodyMedium,
        )
    }
}
