package com.lacaksmb.master.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.lacaksmb.master.data.ApiClient
import com.lacaksmb.master.data.ApiResult
import com.lacaksmb.master.data.Device
import com.lacaksmb.master.ui.components.AppButton
import com.lacaksmb.master.ui.components.AppButtonVariant
import com.lacaksmb.master.ui.components.AppTopBar
import com.lacaksmb.master.ui.components.SectionCard
import com.lacaksmb.master.ui.components.StatusBadge
import com.lacaksmb.master.ui.components.appTextFieldColors
import com.lacaksmb.master.ui.components.deviceStatusBadgeVariant
import com.lacaksmb.master.ui.theme.Accent300
import com.lacaksmb.master.ui.theme.Base300
import com.lacaksmb.master.ui.theme.Base400
import com.lacaksmb.master.ui.theme.Base50
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeviceDetailScreen(deviceId: Int, apiClient: ApiClient, navController: NavHostController) {
    var device by remember { mutableStateOf<Device?>(null) }
    var statusMessage by remember { mutableStateOf<String?>(null) }
    var reasonNote by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var otpCode by remember { mutableStateOf<String?>(null) }
    var refreshTick by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(refreshTick) {
        when (val result = apiClient.getDevice(deviceId)) {
            is ApiResult.Ok -> device = result.data?.let { Device.fromJson(it) }
            is ApiResult.Fail -> statusMessage = result.message
        }
    }

    fun sendCommand(type: String) {
        busy = true
        statusMessage = null
        scope.launch {
            when (val result = apiClient.sendCommand(deviceId, type, reasonNote.ifBlank { null })) {
                is ApiResult.Ok -> {
                    statusMessage = result.message
                    refreshTick++
                }
                is ApiResult.Fail -> statusMessage = result.message
            }
            busy = false
        }
    }

    Scaffold(
        topBar = {
            AppTopBar(
                title = device?.deviceName ?: "Device",
                onBack = { navController.popBackStack() },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            val currentDevice = device
            if (currentDevice == null) {
                CircularProgressIndicator()
                return@Column
            }

            SectionCard(title = "Status Device") {
                StatusBadge(currentDevice.status, deviceStatusBadgeVariant(currentDevice.status))
                Spacer(modifier = Modifier.height(10.dp))
                Text("UUID: ${currentDevice.deviceUuid}", style = MaterialTheme.typography.bodySmall, color = Base400)
                Text(
                    "Android ${currentDevice.androidVersion} · App v${currentDevice.appBuildVersion}",
                    style = MaterialTheme.typography.bodySmall,
                    color = Base400,
                )
                Text("Baterai: ${currentDevice.batteryLevel ?: "-"}%", style = MaterialTheme.typography.bodySmall, color = Base400)
                currentDevice.latestLocation?.let { loc ->
                    Text(
                        "Posisi: ${loc.latitude ?: "-"}, ${loc.longitude ?: "-"} (${loc.source}, ${loc.recordedAt ?: "-"})",
                        style = MaterialTheme.typography.bodySmall,
                        color = Base400,
                    )
                }
                Text(
                    "Terakhir online: ${currentDevice.lastSeenAt ?: "belum pernah"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = Base400,
                )
            }

            Spacer(modifier = Modifier.height(16.dp))

            SectionCard(title = "Kontrol Device") {
                OutlinedTextField(
                    value = reasonNote,
                    onValueChange = { reasonNote = it },
                    label = { Text("Catatan alasan (opsional)") },
                    modifier = Modifier.fillMaxWidth(),
                    colors = appTextFieldColors(),
                )

                Spacer(modifier = Modifier.height(12.dp))

                Row(modifier = Modifier.fillMaxWidth()) {
                    AppButton(
                        text = "Kunci",
                        icon = Icons.Filled.Lock,
                        variant = AppButtonVariant.Danger,
                        onClick = { sendCommand("lock") },
                        enabled = !busy,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    AppButton(
                        text = "Buka",
                        icon = Icons.Filled.LockOpen,
                        variant = AppButtonVariant.Outline,
                        onClick = { sendCommand("unlock") },
                        enabled = !busy,
                        modifier = Modifier.weight(1f),
                    )
                }

                Spacer(modifier = Modifier.height(8.dp))

                AppButton(
                    text = "Minta Lokasi Sekarang",
                    icon = Icons.Filled.MyLocation,
                    variant = AppButtonVariant.Outline,
                    onClick = { sendCommand("locate_now") },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                )

                Spacer(modifier = Modifier.height(8.dp))

                AppButton(
                    text = "Buatkan Kode OTP Self-Unlock",
                    variant = AppButtonVariant.Primary,
                    onClick = {
                        busy = true
                        scope.launch {
                            when (val result = apiClient.generateOtp(deviceId)) {
                                is ApiResult.Ok -> {
                                    otpCode = result.data?.optString("code")
                                    statusMessage = "OTP dibuat, berlaku 5 menit — beri tahu staf kodenya"
                                }
                                is ApiResult.Fail -> statusMessage = result.message
                            }
                            busy = false
                        }
                    },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                )

                otpCode?.let {
                    Text(
                        "Kode OTP: $it",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                        color = Accent300,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                }

                statusMessage?.let {
                    Text(it, color = Base300, modifier = Modifier.padding(top = 12.dp))
                }

                if (busy) {
                    Spacer(modifier = Modifier.height(12.dp))
                    CircularProgressIndicator()
                }
            }
        }
    }
}
