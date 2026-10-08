package com.lacaksmb.master.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
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
import com.lacaksmb.master.data.GeofenceRule
import com.lacaksmb.master.data.SessionStore
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GeofenceScreen(apiClient: ApiClient, sessionStore: SessionStore, navController: NavHostController) {
    var rules by remember { mutableStateOf<List<GeofenceRule>>(emptyList()) }
    var refreshTick by remember { mutableStateOf(0) }
    var statusMessage by remember { mutableStateOf<String?>(null) }

    var ruleName by remember { mutableStateOf("") }
    var ssid by remember { mutableStateOf("") }
    var cidr by remember { mutableStateOf("") }
    var maxDistance by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(refreshTick) {
        when (val result = apiClient.listGeofenceRules(sessionStore.user()?.organizationId)) {
            is ApiResult.Ok -> {
                val items = result.data?.optJSONArray("items")
                rules = (0 until (items?.length() ?: 0)).map { GeofenceRule.fromJson(items!!.getJSONObject(it)) }
            }
            is ApiResult.Fail -> statusMessage = result.message
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Aturan Geofence") },
                navigationIcon = {
                    IconButton(onClick = { navController.popBackStack() }) {
                        Icon(Icons.Filled.ArrowBack, "Kembali")
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            Text("Buat Aturan Baru", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = ruleName,
                onValueChange = { ruleName = it },
                label = { Text("Nama aturan") },
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
            OutlinedTextField(
                value = ssid,
                onValueChange = { ssid = it },
                label = { Text("SSID WiFi diizinkan (opsional)") },
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
            OutlinedTextField(
                value = cidr,
                onValueChange = { cidr = it },
                label = { Text("IP/CIDR diizinkan (opsional)") },
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
            OutlinedTextField(
                value = maxDistance,
                onValueChange = { maxDistance = it },
                label = { Text("Jarak BLE maksimum, meter (opsional)") },
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
            Button(
                onClick = {
                    val orgId = sessionStore.user()?.organizationId ?: return@Button
                    if (ruleName.isBlank()) {
                        statusMessage = "Nama aturan wajib diisi"
                        return@Button
                    }
                    busy = true
                    scope.launch {
                        val result = apiClient.createGeofenceRule(
                            organizationId = orgId,
                            ruleName = ruleName.trim(),
                            allowedSsid = ssid.ifBlank { null },
                            allowedIpCidr = cidr.ifBlank { null },
                            maxDistanceMeters = maxDistance.toIntOrNull(),
                        )
                        when (result) {
                            is ApiResult.Ok -> {
                                statusMessage = "Aturan dibuat"
                                ruleName = ""; ssid = ""; cidr = ""; maxDistance = ""
                                refreshTick++
                            }
                            is ApiResult.Fail -> statusMessage = result.message
                        }
                        busy = false
                    }
                },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            ) { Text("Simpan Aturan") }

            statusMessage?.let { Text(it, modifier = Modifier.padding(top = 8.dp)) }

            Text("Daftar Aturan", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 20.dp, bottom = 8.dp))

            LazyColumn {
                items(rules, key = { it.id }) { rule ->
                    Card(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(12.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(rule.ruleName, style = MaterialTheme.typography.titleSmall)
                                rule.allowedSsid?.let { Text("WiFi: $it", style = MaterialTheme.typography.bodySmall) }
                                rule.allowedIpCidr?.let { Text("IP: $it", style = MaterialTheme.typography.bodySmall) }
                                rule.maxDistanceMeters?.let { Text("Jarak BLE maks: $it m", style = MaterialTheme.typography.bodySmall) }
                            }
                            Switch(
                                checked = rule.isActive,
                                onCheckedChange = {
                                    scope.launch {
                                        apiClient.updateGeofenceRule(rule.id, it)
                                        refreshTick++
                                    }
                                },
                            )
                            IconButton(onClick = {
                                scope.launch {
                                    apiClient.deleteGeofenceRule(rule.id)
                                    refreshTick++
                                }
                            }) { Icon(Icons.Filled.Delete, "Hapus") }
                        }
                    }
                }
            }
        }
    }
}
