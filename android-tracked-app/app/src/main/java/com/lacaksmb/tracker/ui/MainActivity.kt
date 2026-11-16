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
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.remember
import androidx.compose.ui.text.input.KeyboardType
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
import com.lacaksmb.tracker.admin.DevicePolicyRelease
import com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver
import com.lacaksmb.tracker.data.DeviceIdentityStore
import com.lacaksmb.tracker.data.DeviceLockStore
import com.lacaksmb.tracker.network.DeviceOtpApi
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
    private var deviceAdmin by mutableStateOf(false)
    private var deviceUuid by mutableStateOf("")
    private var hint by mutableStateOf<String?>(null)

    // Alur "Lepas perangkat": staf memasukkan kode lepas dari admin untuk mencabut kunci & menghapus app.
    private var releaseDialogOpen by mutableStateOf(false)
    private var releaseCode by mutableStateOf("")
    private var releasing by mutableStateOf(false)
    private var releaseResult by mutableStateOf<String?>(null)
    private var releaseSucceeded by mutableStateOf(false)

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
                        deviceAdmin = deviceAdmin,
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
                        onReleaseDevice = ::openReleaseDialog,
                    )
                    ReleaseDialog(
                        open = releaseDialogOpen,
                        code = releaseCode,
                        onCodeChange = { input -> releaseCode = input.filter { it.isDigit() }.take(6) },
                        busy = releasing,
                        result = releaseResult,
                        succeeded = releaseSucceeded,
                        onSubmit = ::submitRelease,
                        onDismiss = { if (!releasing) releaseDialogOpen = false },
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
        deviceAdmin = SetupChecks.isDeviceAdmin(this)
        // Jangan menyalakan lagi pemantauan setelah perangkat dilepas di sesi ini.
        if (checks[SetupStep.LOCATION] == true && !releaseSucceeded) activateMonitoring()
    }

    private fun openReleaseDialog() {
        releaseCode = ""
        releaseResult = null
        releaseSucceeded = false
        releaseDialogOpen = true
    }

    /**
     * Verifikasi kode lepas ke server, lalu HENTIKAN pemantauan dan lepas kebijakan kunci + status
     * Device Owner/Admin. Urutan: server menandai dilepas -> stop pemantauan (agar service tidak
     * memasang ulang kebijakan Device Owner saat onStartCommand) -> DevicePolicyRelease mencabut
     * blokir uninstall, kunci lokasi, dan status owner/admin.
     */
    private fun submitRelease() {
        val code = releaseCode.trim()
        if (code.length != 6) {
            releaseResult = "Masukkan 6 digit kode lepas dari admin."
            return
        }
        releasing = true
        releaseResult = null
        lifecycleScope.launch {
            val uuid = identityStore.snapshot().deviceUuid
            val result = DeviceOtpApi.verifyRelease(uuid, code)
            if (result.isSuccess) {
                DeviceLockStore(applicationContext).clear()
                identityStore.markReleased()
                ServiceWatchdogWorker.cancel(applicationContext)
                stopService(Intent(this@MainActivity, TrackerForegroundService::class.java))
                val cleared = DevicePolicyRelease.release(applicationContext)
                releasing = false
                releaseSucceeded = true
                releaseResult = if (cleared) {
                    "Perangkat dilepas. Aplikasi sekarang bisa dihapus: tekan-tahan ikon aplikasi lalu " +
                        "pilih Hapus/Uninstall, atau lewat Setelan › Aplikasi."
                } else {
                    "Kode benar dan pemantauan dihentikan, tapi status admin perangkat belum bisa dilepas " +
                        "otomatis. Buka Setelan › Keamanan › Admin perangkat, nonaktifkan Lacak SMB, lalu hapus aplikasi."
                }
                refreshChecks()
            } else {
                releasing = false
                releaseResult = result.exceptionOrNull()?.message ?: "Kode salah atau sudah kedaluwarsa."
            }
        }
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
    deviceAdmin: Boolean,
    connectionText: String,
    connected: Boolean,
    hint: String?,
    onGuide: () -> Unit,
    onStep: (SetupStep) -> Unit,
    onOpenLocationSettings: () -> Unit,
    onOpenAppSettings: () -> Unit,
    onReleaseDevice: () -> Unit,
) {
    val pendingRequired = SetupStep.entries.count { it.required && checks[it] == false }
    val allRequiredDone = checks.isNotEmpty() && pendingRequired == 0

    // Tiap bagian panjang bisa dibuka seperlunya supaya layar utama tetap ringkas (satu layar).
    var expandedStep by remember { mutableStateOf<SetupStep?>(null) }
    var showData by remember { mutableStateOf(false) }
    var showTech by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Lacak SMB", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Aplikasi pelacak resmi HP kantor — ${BuildConfig.SITE_NAME}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.outline,
        )

        // Status koneksi ringkas (satu baris, bukan kartu besar).
        StatusLine(connected = connected, text = connectionText, deviceOwner = deviceOwner)

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

        // Daftar izin RINGKAS: satu baris per izin dalam satu kartu. Ketuk baris untuk membuka
        // penjelasan singkatnya (tidak lagi kartu besar berparagraf satu per satu).
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.fillMaxWidth()) {
                SetupStep.entries.forEachIndexed { index, step ->
                    if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    PermissionRow(
                        step = step,
                        done = checks[step] == true,
                        expanded = expandedStep == step,
                        onToggle = { expandedStep = if (expandedStep == step) null else step },
                        onAction = { onStep(step) },
                    )
                }
            }
        }

        if (Build.MANUFACTURER.lowercase() in AGGRESSIVE_OEMS) {
            InfoCard(
                title = "Khusus HP ${Build.MANUFACTURER}",
                body = "Aktifkan \"Mulai otomatis\"/Autostart dan setel baterai \"Tanpa batasan\" supaya " +
                    "pemantauan tidak dihentikan HP diam-diam.",
                tone = Tone.Warn,
                action = "Buka info aplikasi" to onOpenAppSettings,
            )
        }

        // Keterbukaan data -- WAJIB tetap mudah diakses staf (ini yang membuat pemantauan sah, bukan
        // spyware). Diringkas jadi satu baris "Apa yang dipantau?" yang bisa dibuka; isi lengkap sama
        // persis dengan DeviceInfoCollector.
        DisclosureSection(expanded = showData, onToggle = { showData = !showData })

        if (deviceOwner || deviceAdmin) {
            CompanyLockCard(deviceOwner = deviceOwner, onReleaseDevice = onReleaseDevice)
        }

        TechnicalDetails(
            expanded = showTech,
            onToggle = { showTech = !showTech },
            deviceUuid = deviceUuid,
        )
    }
}

/** Satu baris izin ringkas: nama + status/tombol "Izinkan", dan penjelasan singkat saat baris dibuka. */
@Composable
private fun PermissionRow(
    step: SetupStep,
    done: Boolean,
    expanded: Boolean,
    onToggle: () -> Unit,
    onAction: () -> Unit,
) {
    val statusColor = when {
        done -> MaterialTheme.colorScheme.primary
        step.required -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.outline
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onToggle)
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(if (done) "✓" else "•", style = MaterialTheme.typography.titleMedium, color = statusColor, modifier = Modifier.width(16.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(step.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                Text(
                    if (done) "Sudah diizinkan" else if (step.required) "Perlu diizinkan" else "Opsional",
                    style = MaterialTheme.typography.labelSmall,
                    color = statusColor,
                )
            }
            if (!done) {
                OutlinedButton(onClick = onAction) { Text("Izinkan") }
            }
            Text(if (expanded) "▾" else "▸", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.outline)
        }
        if (expanded) {
            Text(
                step.explanation,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.outline,
                modifier = Modifier.padding(start = 26.dp, top = 6.dp),
            )
        }
    }
}

/** Status koneksi ringkas satu baris (+ penanda HP dikelola kantor). */
@Composable
private fun StatusLine(connected: Boolean, text: String, deviceOwner: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            "●",
            style = MaterialTheme.typography.bodyMedium,
            color = if (connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
        )
        Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        if (deviceOwner) {
            Text("HP kantor", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
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
 * Keterbukaan data -- satu baris "Apa yang dipantau?" yang bisa dibuka. WAJIB tetap mudah diakses
 * staf pemilik HP (ini yang membuat pemantauan sah, bukan spyware): jangan dihapus/disembunyikan.
 * Isi lengkap WAJIB sama dengan DeviceInfoCollector & heartbeat lokasi; kalau ada data baru, bagian
 * ini (dan dokumen consent) diperbarui lebih dulu.
 */
@Composable
private fun DisclosureSection(expanded: Boolean, onToggle: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onToggle)
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(if (expanded) 8.dp else 2.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Apa yang dipantau?", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    Text(
                        "Data yang dikirim ke kantor — ketuk untuk lihat detail",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.outline,
                    )
                }
                Text(if (expanded) "▾" else "▸", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.outline)
            }
            if (expanded) {
                Text(
                    "• Lokasi (GPS/jaringan, akurasi, waktu) berkala dan saat diminta admin\n" +
                        "• Merek, model, versi Android, versi aplikasi\n" +
                        "• Baterai & status mengisi daya\n" +
                        "• Jenis jaringan (WiFi/seluler), nama WiFi, nama operator\n" +
                        "• Sisa penyimpanan, status izin aplikasi ini\n" +
                        "• Status kunci perusahaan (lokasi & anti-hapus) dan status GPS\n" +
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
}

/** Detail teknis (ID Device & versi aplikasi) -- disembunyikan di balik ketukan supaya tidak memenuhi layar. */
@Composable
private fun TechnicalDetails(expanded: Boolean, onToggle: () -> Unit, deviceUuid: String) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onToggle)
                .padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Detail teknis",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.outline,
                modifier = Modifier.weight(1f),
            )
            Text(if (expanded) "▾" else "▸", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.outline)
        }
        if (expanded) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("ID Device", style = MaterialTheme.typography.labelMedium)
                Text(deviceUuid.ifBlank { "Memuat…" }, style = MaterialTheme.typography.bodySmall)
                Text(
                    "Versi aplikasi ${BuildConfig.VERSION_NAME}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.outline,
                )
            }
        }
    }
}

/**
 * Pengungkapan kunci perusahaan -- JUJUR menjelaskan bahwa lokasi & penghapusan aplikasi dikunci
 * perusahaan dan cara melepasnya (minta kode ke admin). Hanya tampil di HP yang memang dikelola
 * (Device Owner / Device Admin), sesuai persetujuan tertulis.
 */
@Composable
private fun CompanyLockCard(deviceOwner: Boolean, onReleaseDevice: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Perangkat dikunci perusahaan", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text(
                if (deviceOwner) {
                    "Selama aplikasi aktif: Lokasi/GPS dikunci menyala dan tidak bisa dimatikan, dan " +
                        "aplikasi ini tidak bisa dihapus tanpa kode lepas dari admin kantor."
                } else {
                    "Aplikasi ini terpasang sebagai admin perangkat untuk kunci layar jarak jauh. " +
                        "Untuk melepasnya sepenuhnya, minta kode lepas dari admin kantor."
                },
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                "Untuk melepas (mis. HP dikembalikan / diganti): minta \"kode lepas perangkat\" ke admin " +
                    "di dashboard, lalu masukkan di bawah ini.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.outline,
            )
            OutlinedButton(onClick = onReleaseDevice) { Text("Lepas perangkat") }
        }
    }
}

/** Dialog masukkan kode lepas perangkat. Setelah berhasil, pesan memandu staf menghapus aplikasi. */
@Composable
private fun ReleaseDialog(
    open: Boolean,
    code: String,
    onCodeChange: (String) -> Unit,
    busy: Boolean,
    result: String?,
    succeeded: Boolean,
    onSubmit: () -> Unit,
    onDismiss: () -> Unit,
) {
    if (!open) return
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (succeeded) "Perangkat dilepas" else "Lepas perangkat") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (!succeeded) {
                    Text(
                        "Masukkan 6 digit kode lepas yang dibuat admin di dashboard. Kode ini mencabut " +
                            "kunci lokasi & penghapusan, lalu melepas aplikasi dari HP.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    OutlinedTextField(
                        value = code,
                        onValueChange = onCodeChange,
                        singleLine = true,
                        enabled = !busy,
                        label = { Text("Kode lepas (6 digit)") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                result?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (succeeded) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            if (succeeded) {
                TextButton(onClick = onDismiss) { Text("Tutup") }
            } else {
                TextButton(onClick = onSubmit, enabled = !busy && code.length == 6) {
                    Text(if (busy) "Memproses…" else "Lepaskan")
                }
            }
        },
        dismissButton = {
            if (!succeeded) {
                TextButton(onClick = onDismiss, enabled = !busy) { Text("Batal") }
            }
        },
    )
}
