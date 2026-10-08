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
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.lacaksmb.master.data.ApiClient
import com.lacaksmb.master.data.ApiResult
import com.lacaksmb.master.data.Device
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
            TopAppBar(
                title = { Text(device?.deviceName ?: "Device") },
                navigationIcon = {
                    IconButton(onClick = { navController.popBackStack() }) {
                        Icon(Icons.Filled.ArrowBack, "Kembali")
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            val currentDevice = device
            if (currentDevice == null) {
                CircularProgressIndicator()
                return@Column
            }

            StatusBadge(currentDevice.status)
            Text("UUID: ${currentDevice.deviceUuid}", style = MaterialTheme.typography.bodySmall)
            Text("Android ${currentDevice.androidVersion} · App v${currentDevice.appBuildVersion}", style = MaterialTheme.typography.bodySmall)
            Text("Baterai: ${currentDevice.batteryLevel ?: "-"}%", style = MaterialTheme.typography.bodySmall)
            currentDevice.latestLocation?.let { loc ->
                Text(
                    "Posisi: ${loc.latitude ?: "-"}, ${loc.longitude ?: "-"} (${loc.source}, ${loc.recordedAt ?: "-"})",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Text("Terakhir online: ${currentDevice.lastSeenAt ?: "belum pernah"}", style = MaterialTheme.typography.bodySmall)

            HorizontalDivider(modifier = Modifier.padding(vertical = 16.dp))

            OutlinedTextField(
                value = reasonNote,
                onValueChange = { reasonNote = it },
                label = { Text("Catatan alasan (opsional)") },
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(modifier = Modifier.height(12.dp))

            Row(modifier = Modifier.fillMaxWidth()) {
                Button(
                    onClick = { sendCommand("lock") },
                    enabled = !busy,
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                    modifier = Modifier.weight(1f),
                ) {
                    Icon(Icons.Filled.Lock, null, modifier = Modifier.height(18.dp))
                    Text(" Kunci")
                }
                Spacer(modifier = Modifier.width(8.dp))
                Button(onClick = { sendCommand("unlock") }, enabled = !busy, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Filled.LockOpen, null, modifier = Modifier.height(18.dp))
                    Text(" Buka")
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            Button(onClick = { sendCommand("locate_now") }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Filled.MyLocation, null, modifier = Modifier.height(18.dp))
                Text(" Minta Lokasi Sekarang")
            }

            Spacer(modifier = Modifier.height(8.dp))

            Button(
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
            ) {
                Text("Buatkan Kode OTP Self-Unlock")
            }

            otpCode?.let {
                Text(
                    "Kode OTP: $it",
                    style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }

            statusMessage?.let {
                Text(it, modifier = Modifier.padding(top = 12.dp))
            }

            if (busy) {
                Spacer(modifier = Modifier.height(12.dp))
                CircularProgressIndicator()
            }
        }
    }
}
