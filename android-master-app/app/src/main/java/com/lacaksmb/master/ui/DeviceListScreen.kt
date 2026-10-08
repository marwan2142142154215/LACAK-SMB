package com.lacaksmb.master.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Rule
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.lacaksmb.master.data.ApiClient
import com.lacaksmb.master.data.ApiResult
import com.lacaksmb.master.data.Device
import com.lacaksmb.master.data.SessionStore
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeviceListScreen(apiClient: ApiClient, sessionStore: SessionStore, navController: NavHostController) {
    var devices by remember { mutableStateOf<List<Device>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var refreshTick by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(refreshTick) {
        loading = true
        val user = sessionStore.user()
        when (val result = apiClient.listDevices(user?.organizationId)) {
            is ApiResult.Ok -> {
                val items = result.data?.optJSONArray("items")
                devices = (0 until (items?.length() ?: 0)).map { Device.fromJson(items!!.getJSONObject(it)) }
                errorText = null
            }
            is ApiResult.Fail -> errorText = result.message
        }
        loading = false
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Device (${devices.size})") },
                actions = {
                    IconButton(onClick = { refreshTick++ }) { Icon(Icons.Filled.Refresh, "Refresh") }
                    IconButton(onClick = { navController.navigate(Routes.RADAR) }) { Icon(Icons.Filled.LocationOn, "Radar") }
                    IconButton(onClick = { navController.navigate(Routes.GEOFENCE) }) { Icon(Icons.Filled.Rule, "Geofence") }
                    IconButton(onClick = { navController.navigate(Routes.CONSENT) }) { Icon(Icons.Filled.VerifiedUser, "Consent") }
                    IconButton(onClick = {
                        scope.launch { apiClient.logout() }
                        sessionStore.clear()
                        navController.navigate(Routes.LOGIN) { popUpTo(0) }
                    }) { Icon(Icons.Filled.Logout, "Keluar") }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            when {
                loading -> Row(
                    modifier = Modifier.fillMaxWidth().padding(32.dp),
                    horizontalArrangement = Arrangement.Center,
                ) { CircularProgressIndicator() }

                errorText != null -> Text(
                    errorText!!,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(16.dp),
                )

                devices.isEmpty() -> Text("Belum ada device terdaftar", modifier = Modifier.padding(16.dp))

                else -> LazyColumn {
                    items(devices, key = { it.id }) { device ->
                        DeviceCard(device) { navController.navigate(Routes.deviceDetail(device.id)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun DeviceCard(device: Device, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp),
        onClick = onClick,
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(device.deviceName, style = MaterialTheme.typography.titleMedium)
                Spacer(modifier = Modifier.width(8.dp))
                StatusBadge(device.status)
            }
            Spacer(modifier = Modifier.width(4.dp))
            Text(
                "Baterai: ${device.batteryLevel ?: "-"}%  ·  Android ${device.androidVersion}",
                style = MaterialTheme.typography.bodySmall,
            )
            device.latestLocation?.let {
                Text(
                    "Posisi terakhir: ${it.latitude ?: "-"}, ${it.longitude ?: "-"}",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Text(
                "Terakhir online: ${device.lastSeenAt ?: "belum pernah"}",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
fun StatusBadge(status: String) {
    val color = when (status) {
        "online" -> MaterialTheme.colorScheme.primary
        "locked" -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.secondary
    }
    Text(status, color = color, style = MaterialTheme.typography.labelMedium)
}
