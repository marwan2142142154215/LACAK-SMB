package com.lacaksmb.tracker.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.admin.DevicePolicyManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.core.content.edit
import androidx.core.net.toUri
import android.os.Build
import android.os.Bundle
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.lifecycleScope
import com.lacaksmb.tracker.BuildConfig
import com.lacaksmb.tracker.R
import com.lacaksmb.tracker.admin.DeviceOwnerSetup
import com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver
import com.lacaksmb.tracker.data.DeviceIdentityStore
import com.lacaksmb.tracker.data.DeviceLockStore
import com.lacaksmb.tracker.service.ServiceWatchdogWorker
import com.lacaksmb.tracker.service.TrackerForegroundService
import com.lacaksmb.tracker.service.TrackerStatus
import com.lacaksmb.tracker.setup.SetupChecks
import com.lacaksmb.tracker.ui.theme.LacakTrackerTheme
import kotlinx.coroutines.launch

/**
 * Layar panduan pemasangan APK Pelacak. SENGAJA tanpa input teks (kode site, alamat server, dan
 * identitas device ditanam saat build dari menu Build APK). Pemegang HP / teknisi cukup menekan
 * "Mulai penyiapan": setiap izin diminta BERURUTAN, masing-masing dengan penjelasan untuk apa
 * dipakai, lalu otomatis lanjut ke langkah berikutnya setelah kembali dari halaman Setelan.
 *
 * Semua status dibaca ulang dari sistem setiap kali layar ini tampil, jadi izin yang dicabut
 * belakangan langsung terlihat sebagai "perlu tindakan" (dan dilaporkan ke dashboard lewat
 * DeviceInfoCollector). Pemantauan dimulai SEGERA setelah izin lokasi diberikan -- langkah sisanya
 * menyempurnakan keandalan, tidak menahan HP untuk online.
 *
 * Catatan platform Android: app yang BARU diinstal berada dalam "stopped state" dan tidak menerima
 * broadcast apa pun (termasuk BOOT_COMPLETED) sampai dibuka minimal sekali secara manual.
 */
class MainActivity : ComponentActivity() {

    private lateinit var identityStore: DeviceIdentityStore

    private var checks by mutableStateOf<Map<SetupStep, Boolean>>(emptyMap())
    private var locationServiceOn by mutableStateOf(true)
    private var deviceOwner by mutableStateOf(false)
    private var deviceUuid by mutableStateOf("")
    private var hint by mutableStateOf<String?>(null)

    // Mode "pandu saya": setelah satu langkah selesai, langsung lanjut ke langkah berikutnya.
    private var guiding = false
    private var lastAttempted: SetupStep? = null

    private val locationLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { onStepReturned() }

    private val singlePermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { onStepReturned() }

    private val multiPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { onStepReturned() }

    private val settingsLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { onStepReturned() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        identityStore = DeviceIdentityStore(applicationContext)

        // HP aset perusahaan yang dipasang lewat QR (Device Owner): izin diberikan otomatis.
        DeviceOwnerSetup.applyIfDeviceOwner(applicationContext)
        lifecycleScope.launch {
            deviceUuid = identityStore.ensureDeviceUuid()
            identityStore.ensureDeviceSecretFromBuild()
        }

        setContent {
            LacakTrackerTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    val status by TrackerStatus.text.collectAsState()
                    val connected by TrackerStatus.connected.collectAsState()
                    SetupScreen(
                        deviceUuid = deviceUuid,
                        checks = checks,
                        locationServiceOn = locationServiceOn,
                        deviceOwner = deviceOwner,
                        connectionText = status,
                        connected = connected,
                        hint = hint,
                        onGuide = ::startGuide,
                        onStep = { step ->
                            guiding = false
                            runStep(step)
                        },
                        onOpenLocationSettings = {
                            openSettings(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS))
                        },
                        onOpenAppSettings = { openSettings(appDetailsIntent()) },
                    )
                }
            }
        }

        lifecycle.addObserver(
            LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_RESUME) {
                    // Pertahanan kunci: kalau status masih "dikunci admin" dan app kebetulan dibuka
                    // (mis. via notifikasi), kunci lagi — tidak ada jalan pintas lewat app ini.
                    lifecycleScope.launch {
                        val lock = DeviceLockStore(applicationContext).snapshot()
                        if (lock.adminLocked) {
                            TrackerDeviceAdminReceiver.lockNow(applicationContext)
                        }
                    }
                    refreshChecks()
                }
            },
        )
    }

    /** Baca ulang semua izin dari sistem; mulai pemantauan begitu izin lokasi ada. */
    private fun refreshChecks() {
        checks = SetupStep.entries.associateWith { it.isDone(this) }
        locationServiceOn = SetupChecks.isLocationServiceOn(this)
        deviceOwner = SetupChecks.isDeviceOwner(this)
        if (checks[SetupStep.LOCATION] == true) activateMonitoring()
    }

    /**
     * Simpan pendaftaran (identitas sudah tertanam saat build) & jalankan service. Aman dipanggil
     * berulang: service yang sudah jalan tidak terpengaruh.
     */
    private fun activateMonitoring() {
        lifecycleScope.launch {
            identityStore.ensureDeviceUuid()
            identityStore.ensureDeviceSecretFromBuild()
            identityStore.saveEnrollment(BuildConfig.SITE_CODE, BuildConfig.GATEWAY_URL)
            ServiceWatchdogWorker.schedule(applicationContext)
            TrackerForegroundService.startSafely(applicationContext)
        }
    }

    private fun startGuide() {
        guiding = true
        hint = null
        lastAttempted = null
        continueGuide()
    }

    private fun continueGuide() {
        val next = SetupStep.entries.firstOrNull { !it.isDone(this) && it.isAvailable(this) }
        if (next == null) {
            guiding = false
            hint = "Semua langkah selesai. HP ini siap dipantau — aplikasi boleh ditutup."
            return
        }
        runStep(next)
    }

    /** Kembali dari dialog izin / halaman Setelan: periksa ulang lalu lanjut atau beri petunjuk. */
    private fun onStepReturned() {
        refreshChecks()
        val attempted = lastAttempted ?: return
        if (attempted.isDone(this)) {
            hint = null
            if (guiding) continueGuide()
        } else {
            // Ditolak/dibatalkan: berhenti dan jelaskan, jangan berputar meminta terus-menerus.
            guiding = false
            hint = attempted.retryHint
        }
    }

    private fun runStep(step: SetupStep) {
        lastAttempted = step
        when (step) {
            SetupStep.LOCATION -> {
                val permissions = arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                )
                if (permanentlyDenied(Manifest.permission.ACCESS_FINE_LOCATION)) {
                    openSettings(appDetailsIntent())
                } else {
                    locationLauncher.launch(permissions)
                }
            }

            SetupStep.BACKGROUND_LOCATION -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                    onStepReturned()
                } else if (Build.VERSION.SDK_INT == Build.VERSION_CODES.Q ||
                    !permanentlyDenied(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                ) {
                    // Android 10: dialog dengan pilihan "Izinkan sepanjang waktu". Android 11+:
                    // sistem langsung membuka halaman izin lokasi app ini.
                    singlePermissionLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                } else {
                    openSettings(appDetailsIntent())
                }
            }

            SetupStep.NOTIFICATIONS -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                    !permanentlyDenied(Manifest.permission.POST_NOTIFICATIONS)
                ) {
                    singlePermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                } else {
                    openSettings(
                        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, packageName),
                    )
                }
            }

            SetupStep.DEVICE_ADMIN -> {
                val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
                    putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, TrackerDeviceAdminReceiver.componentName(this@MainActivity))
                    putExtra(
                        DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                        "Hanya untuk mengunci layar HP ini dari jarak jauh oleh admin kantor, sesuai " +
                            "persetujuan tertulis. Aplikasi ini tidak bisa menghapus data HP.",
                    )
                }
                openSettings(intent)
            }

            SetupStep.OVERLAY -> openSettings(
                Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, "package:$packageName".toUri()),
            )

            SetupStep.BATTERY -> openSettings(batteryExemptionIntent())

            SetupStep.BLUETOOTH -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    multiPermissionLauncher.launch(
                        arrayOf(
                            Manifest.permission.BLUETOOTH_SCAN,
                            Manifest.permission.BLUETOOTH_CONNECT,
                            Manifest.permission.BLUETOOTH_ADVERTISE,
                        ),
                    )
                } else {
                    onStepReturned()
                }
            }
        }
    }

    /** Pernah ditolak permanen ("Jangan tanya lagi"): dialog tidak akan muncul, arahkan ke Setelan. */
    private fun permanentlyDenied(permission: String): Boolean {
        val asked = getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("asked_$permission", false)
        getSharedPreferences(PREFS, MODE_PRIVATE).edit { putBoolean("asked_$permission", true) }
        return asked &&
            checkSelfPermission(permission) != android.content.pm.PackageManager.PERMISSION_GRANTED &&
            !shouldShowRequestPermissionRationale(permission)
    }

    @SuppressLint("BatteryLife")
    private fun batteryExemptionIntent(): Intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, "package:$packageName".toUri())

    private fun appDetailsIntent(): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))

    private fun openSettings(intent: Intent) {
        try {
            settingsLauncher.launch(intent)
        } catch (_: ActivityNotFoundException) {
            // Sebagian OEM menghapus halaman setelan tertentu -- jatuh ke halaman info aplikasi.
            try {
                settingsLauncher.launch(appDetailsIntent())
            } catch (_: ActivityNotFoundException) {
                hint = "Halaman setelan tidak tersedia di HP ini. Buka Setelan → Aplikasi → ${getString(R.string.app_name)} secara manual."
            }
        }
    }

    companion object {
        private const val PREFS = "setup_prompts"
    }
}

/**
 * Langkah penyiapan, urut sesuai yang diminta. Teks penjelasan ditampilkan apa adanya ke pemegang
 * HP -- harus jujur tentang untuk apa izin dipakai.
 */
private enum class SetupStep(
    val title: String,
    val explanation: String,
    val required: Boolean,
    val retryHint: String,
) {
    LOCATION(
        "Izin lokasi",
        "Untuk mengirim posisi HP ini ke kantor. Pilih \"Saat aplikasi digunakan\" lalu \"Lokasi akurat\".",
        true,
        "Izin lokasi wajib supaya pemantauan berjalan. Tekan \"Izinkan\" pada langkah Izin lokasi.",
    ),
    BACKGROUND_LOCATION(
        "Lokasi \"Izinkan sepanjang waktu\"",
        "Supaya posisi tetap terkirim saat layar mati atau aplikasi tidak dibuka.",
        true,
        "Di halaman izin Lokasi pilih \"Izinkan sepanjang waktu\", lalu kembali ke aplikasi ini.",
    ),
    NOTIFICATIONS(
        "Notifikasi pemantauan",
        "Notifikasi \"Lacak SMB sedang memantau\" selalu tampil selama pemantauan aktif.",
        true,
        "Aktifkan notifikasi untuk aplikasi ini, lalu kembali.",
    ),
    DEVICE_ADMIN(
        "Kunci layar jarak jauh",
        "Admin kantor bisa mengunci layar HP ini dari dashboard. Tidak bisa menghapus data HP.",
        true,
        "Pilih \"Aktifkan\" pada halaman Admin perangkat supaya kunci jarak jauh bisa dipakai.",
    ),
    OVERLAY(
        "Tampil di atas aplikasi lain",
        "Supaya layar kunci bisa muncul walau aplikasi ini sedang tidak dibuka.",
        true,
        "Aktifkan \"Izinkan tampil di atas aplikasi lain\" untuk aplikasi ini, lalu kembali.",
    ),
    BATTERY(
        "Tanpa batasan baterai",
        "Supaya Android tidak menghentikan pemantauan saat HP lama tidak dipakai, dan perintah dari kantor tetap sampai.",
        true,
        "Pilih \"Izinkan\" agar aplikasi tidak dibatasi penghemat baterai.",
    ),
    BLUETOOTH(
        "Perangkat sekitar / Bluetooth (opsional)",
        "Untuk radar jarak dekat ke titik kantor atau HP admin. Boleh dilewati.",
        false,
        "Bluetooth dilewati. Radar jarak dekat tidak aktif, pemantauan lain tetap berjalan.",
    ),
    ;

    fun isDone(activity: ComponentActivity): Boolean = when (this) {
        LOCATION -> SetupChecks.hasForegroundLocation(activity)
        BACKGROUND_LOCATION -> SetupChecks.hasBackgroundLocation(activity)
        NOTIFICATIONS -> SetupChecks.hasNotifications(activity)
        DEVICE_ADMIN -> SetupChecks.isDeviceAdmin(activity) || SetupChecks.isDeviceOwner(activity)
        OVERLAY -> SetupChecks.canShowLockScreen(activity)
        BATTERY -> SetupChecks.isBatteryUnrestricted(activity)
        BLUETOOTH -> SetupChecks.hasBluetooth(activity)
    }

    /** Langkah yang bergantung pada langkah lain baru bisa dijalankan setelah prasyaratnya beres. */
    fun isAvailable(activity: ComponentActivity): Boolean = when (this) {
        BACKGROUND_LOCATION -> SetupChecks.hasForegroundLocation(activity)
        else -> true
    }
}

/** Merek yang dikenal mematikan aplikasi latar belakang tanpa izin "Mulai otomatis". */
private val AGGRESSIVE_OEMS = setOf(
    "xiaomi", "redmi", "poco", "oppo", "realme", "vivo", "iqoo", "huawei", "honor",
    "oneplus", "infinix", "tecno", "itel", "meizu", "asus",
)

@Composable
private fun SetupScreen(
    deviceUuid: String,
    checks: Map<SetupStep, Boolean>,
    locationServiceOn: Boolean,
    deviceOwner: Boolean,
    connectionText: String,
    connected: Boolean,
    hint: String?,
    onGuide: () -> Unit,
    onStep: (SetupStep) -> Unit,
    onOpenLocationSettings: () -> Unit,
    onOpenAppSettings: () -> Unit,
) {
    val pendingRequired = SetupStep.entries.count { it.required && checks[it] == false }
    val allRequiredDone = checks.isNotEmpty() && pendingRequired == 0

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Lacak SMB", style = MaterialTheme.typography.headlineMedium)
        Text("Aplikasi pelacak resmi HP kantor — ${BuildConfig.SITE_NAME}", style = MaterialTheme.typography.titleSmall)

        // Status koneksi langsung dari service.
        InfoCard(
            title = if (connected) "Terhubung ke server" else "Status pemantauan",
            body = connectionText,
            tone = if (connected) Tone.Good else Tone.Neutral,
        )

        if (deviceOwner) {
            InfoCard(
                title = "HP dikelola kantor",
                body = "HP ini dipasang sebagai perangkat kantor (Device Owner). Sebagian izin sudah diatur otomatis.",
                tone = Tone.Neutral,
            )
        }

        if (!locationServiceOn) {
            InfoCard(
                title = "Lokasi HP sedang mati",
                body = "Nyalakan Lokasi/GPS di pengaturan cepat supaya posisi bisa terkirim.",
                tone = Tone.Warn,
                action = "Buka setelan lokasi" to onOpenLocationSettings,
            )
        }

        // Ringkasan + tombol utama.
        Text(
            when {
                checks.isEmpty() -> "Memeriksa izin…"
                allRequiredDone -> "Semua langkah wajib selesai ✓"
                else -> "$pendingRequired langkah lagi supaya pemantauan andal"
            },
            style = MaterialTheme.typography.titleMedium,
        )
        if (!allRequiredDone) {
            Button(onClick = onGuide, modifier = Modifier.fillMaxWidth()) {
                Text(if (pendingRequired == SetupStep.entries.count { it.required }) "Mulai penyiapan" else "Lanjutkan penyiapan")
            }
        }
        hint?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.tertiary) }

        SetupStep.entries.forEachIndexed { index, step ->
            StepCard(number = index + 1, step = step, done = checks[step] == true, onAction = { onStep(step) })
        }

        if (Build.MANUFACTURER.lowercase() in AGGRESSIVE_OEMS) {
            InfoCard(
                title = "Khusus HP ${Build.MANUFACTURER}",
                body = "Buka Info aplikasi lalu aktifkan \"Mulai otomatis\" / \"Autostart\" dan setel baterai ke " +
                    "\"Tanpa batasan\". Tanpa ini HP merek ini bisa menghentikan pemantauan diam-diam.",
                tone = Tone.Warn,
                action = "Buka info aplikasi" to onOpenAppSettings,
            )
        }

        DisclosureCard()

        Text("ID Device", style = MaterialTheme.typography.labelMedium)
        Text(deviceUuid.ifBlank { "Memuat…" }, style = MaterialTheme.typography.bodySmall)
        Text(
            "Versi aplikasi ${BuildConfig.VERSION_NAME}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.outline,
        )
    }
}

@Composable
private fun StepCard(number: Int, step: SetupStep, done: Boolean, onAction: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                if (done) "✓" else "$number",
                style = MaterialTheme.typography.titleLarge,
                color = if (done) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
                modifier = Modifier.width(28.dp),
            )
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(step.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(step.explanation, style = MaterialTheme.typography.bodySmall)
                Text(
                    if (done) "Sudah diizinkan" else if (step.required) "Perlu tindakan" else "Opsional",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (done) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error.takeIf { step.required }
                        ?: MaterialTheme.colorScheme.outline,
                )
            }
            if (!done) {
                OutlinedButton(onClick = onAction) { Text("Izinkan") }
            }
        }
    }
}

private enum class Tone { Good, Neutral, Warn }

@Composable
private fun InfoCard(title: String, body: String, tone: Tone, action: Pair<String, () -> Unit>? = null) {
    val container = when (tone) {
        Tone.Good -> MaterialTheme.colorScheme.primaryContainer
        Tone.Neutral -> MaterialTheme.colorScheme.surfaceVariant
        Tone.Warn -> MaterialTheme.colorScheme.errorContainer
    }
    Card(modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = container)) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text(body, style = MaterialTheme.typography.bodySmall)
            action?.let { (label, onClick) -> OutlinedButton(onClick = onClick) { Text(label) } }
        }
    }
}

/**
 * Pengungkapan data -- WAJIB sama dengan isi DeviceInfoCollector & heartbeat lokasi. Kalau ada
 * data baru yang dikirim, kartu ini (dan dokumen consent) harus diperbarui lebih dulu.
 */
@Composable
private fun DisclosureCard() {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Data yang dikirim ke kantor", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text(
                "• Lokasi (GPS/jaringan, akurasi, waktu) berkala dan saat diminta admin\n" +
                    "• Merek, model, versi Android, versi aplikasi\n" +
                    "• Baterai & status mengisi daya\n" +
                    "• Jenis jaringan (WiFi/seluler), nama WiFi, nama operator\n" +
                    "• Sisa penyimpanan, status izin aplikasi ini\n" +
                    "• Sinyal Bluetooth ke titik kantor (bila diizinkan)",
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                "Tidak pernah dikirim: isi pesan, kontak, riwayat panggilan, foto/berkas, atau isi aplikasi lain. " +
                    "Notifikasi pemantauan selalu tampil selama aplikasi aktif, sesuai persetujuan tertulis.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.outline,
            )
        }
    }
}
