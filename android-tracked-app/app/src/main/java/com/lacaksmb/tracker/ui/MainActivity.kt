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
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver
import com.lacaksmb.tracker.data.DeviceIdentityStore
import com.lacaksmb.tracker.service.TrackerForegroundService
import com.lacaksmb.tracker.ui.theme.LacakTrackerTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private lateinit var identityStore: DeviceIdentityStore

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { /* hasil ditangani lewat pengecekan ulang status izin di UI */ }

    private val deviceAdminLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { /* status Device Admin dibaca ulang langsung dari DevicePolicyManager */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        identityStore = DeviceIdentityStore(applicationContext)

        setContent {
            LacakTrackerTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    EnrollmentScreen(
                        identityStore = identityStore,
                        onRequestRuntimePermissions = { permissions -> permissionLauncher.launch(permissions) },
                        onRequestDeviceAdmin = { requestDeviceAdmin() },
                        onRequestBatteryExemption = { requestBatteryOptimizationExemption() },
                        onOpenBackgroundLocationSettings = { openAppSettings() },
                        onStartService = { TrackerForegroundService.start(applicationContext) },
                    )
                }
            }
        }
    }

    private fun requestDeviceAdmin() {
        val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
            putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, TrackerDeviceAdminReceiver.componentName(this@MainActivity))
            putExtra(
                DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                "Diperlukan supaya admin bisa mengunci layar device ini dari jarak jauh sesuai persetujuan yang berlaku.",
            )
        }
        deviceAdminLauncher.launch(intent)
    }

    @SuppressLint("BatteryLife")
    private fun requestBatteryOptimizationExemption() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            val intent = Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:$packageName"),
            )
            startActivity(intent)
        }
    }

    private fun openAppSettings() {
        // Android 11+ (API 30+): izin lokasi latar belakang tidak bisa
        // diminta lewat dialog biasa, wajib diarahkan ke halaman setelan
        // app ("Izinkan selalu").
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", packageName, null)
        }
        startActivity(intent)
    }
}

@Composable
private fun EnrollmentScreen(
    identityStore: DeviceIdentityStore,
    onRequestRuntimePermissions: (Array<String>) -> Unit,
    onRequestDeviceAdmin: () -> Unit,
    onRequestBatteryExemption: () -> Unit,
    onOpenBackgroundLocationSettings: () -> Unit,
    onStartService: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var deviceUuid by remember { mutableStateOf("") }
    var siteCode by remember { mutableStateOf("") }
    var gatewayUrl by remember { mutableStateOf(DeviceIdentityStore.DEFAULT_GATEWAY_URL) }
    var isEnrolled by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        deviceUuid = identityStore.ensureDeviceUuid()
        val snapshot = identityStore.snapshot()
        isEnrolled = snapshot.isEnrolled
        if (snapshot.siteCode.isNotBlank()) siteCode = snapshot.siteCode
        if (snapshot.gatewayUrl.isNotBlank()) gatewayUrl = snapshot.gatewayUrl
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Lacak SMB", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Aplikasi pelacak resmi. Pendaftaran device hanya sah dengan dokumen consent yang berlaku.",
            style = MaterialTheme.typography.bodyMedium,
        )

        Text("ID Device (berikan ke admin untuk didaftarkan):", style = MaterialTheme.typography.labelMedium)
        Text(deviceUuid.ifBlank { "Memuat..." }, style = MaterialTheme.typography.bodySmall)

        if (isEnrolled) {
            Text("Status: Terdaftar — layanan pemantauan aktif.", style = MaterialTheme.typography.bodyLarge)
            Button(onClick = onStartService, modifier = Modifier.fillMaxWidth()) {
                Text("Mulai Ulang Pemantauan")
            }
        } else {
            OutlinedTextField(
                value = siteCode,
                onValueChange = { siteCode = it },
                label = { Text("Kode Site (dari admin)") },
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = gatewayUrl,
                onValueChange = { gatewayUrl = it },
                label = { Text("Alamat Gateway") },
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(4.dp))
            Text("Langkah izin (wajib dijalankan berurutan):", style = MaterialTheme.typography.labelMedium)

            Button(
                onClick = {
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
                    onRequestRuntimePermissions(permissions.toTypedArray())
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("1. Izinkan Lokasi, Bluetooth & Notifikasi")
            }

            Button(onClick = onOpenBackgroundLocationSettings, modifier = Modifier.fillMaxWidth()) {
                Text("2. Izinkan Lokasi \"Selalu\" (buka Setelan)")
            }

            Button(onClick = onRequestDeviceAdmin, modifier = Modifier.fillMaxWidth()) {
                Text("3. Aktifkan Kemampuan Lock Jarak Jauh")
            }

            Button(onClick = onRequestBatteryExemption, modifier = Modifier.fillMaxWidth()) {
                Text("4. Kecualikan dari Optimisasi Baterai")
            }

            Button(
                onClick = {
                    scope.launch {
                        identityStore.saveEnrollment(siteCode.trim(), gatewayUrl.trim())
                        isEnrolled = true
                        onStartService()
                    }
                },
                enabled = siteCode.isNotBlank() && gatewayUrl.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("5. Selesai & Mulai Pemantauan")
            }
        }
    }
}
