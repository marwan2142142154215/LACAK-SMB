package com.lacaksmb.master.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import com.lacaksmb.master.data.GeofenceRule
import com.lacaksmb.master.data.SessionStore
import com.lacaksmb.master.ui.components.AppButton
import com.lacaksmb.master.ui.components.AppTopBar
import com.lacaksmb.master.ui.components.BadgeVariant
import com.lacaksmb.master.ui.components.SectionCard
import com.lacaksmb.master.ui.components.StatusBadge
import com.lacaksmb.master.ui.components.appTextFieldColors
import com.lacaksmb.master.ui.theme.Accent300
import com.lacaksmb.master.ui.theme.Accent500
import com.lacaksmb.master.ui.theme.Base300
import com.lacaksmb.master.ui.theme.Base400
import com.lacaksmb.master.ui.theme.Base50
import com.lacaksmb.master.ui.theme.Base600
import com.lacaksmb.master.ui.theme.Base800
import com.lacaksmb.master.ui.theme.Base900
import com.lacaksmb.master.ui.theme.Base950
import com.lacaksmb.master.ui.theme.Danger400
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

    // Admin & leader mengelola beberapa site yang diberikan ke akunnya:
    // daftar aturan memuat semua site itu, dan site aturan baru dipilih.
    val user = sessionStore.user()
    val grantBased = user != null && "super_admin" !in user.roles &&
        user.roles.any { it == "admin" || it == "leader" }
    var sites by remember { mutableStateOf<List<Pair<Int, String>>>(emptyList()) }
    var selectedSiteId by remember { mutableStateOf<Int?>(null) }

    LaunchedEffect(Unit) {
        sites = apiClient.listSites()
        selectedSiteId = sites.firstOrNull { it.first == user?.organizationId }?.first
            ?: sites.firstOrNull()?.first
            ?: user?.organizationId
    }

    LaunchedEffect(refreshTick) {
        when (val result = apiClient.listGeofenceRules(if (grantBased) null else user?.organizationId)) {
            is ApiResult.Ok -> {
                val items = result.data?.optJSONArray("items")
                rules = (0 until (items?.length() ?: 0)).map { GeofenceRule.fromJson(items!!.getJSONObject(it)) }
            }
            is ApiResult.Fail -> statusMessage = result.message
        }
    }

    Scaffold(
        topBar = {
            AppTopBar(title = "Aturan Geofence", onBack = { navController.popBackStack() })
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            SectionCard(title = "Buat Aturan Baru") {
                if (sites.size > 1) {
                    Text("Site", style = MaterialTheme.typography.labelMedium, color = Base400)
                    Row(
                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 4.dp, bottom = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        sites.forEach { (id, name) ->
                            FilterChip(
                                selected = selectedSiteId == id,
                                onClick = { selectedSiteId = id },
                                label = { Text(name) },
                                colors = FilterChipDefaults.filterChipColors(
                                    containerColor = Base900,
                                    labelColor = Base400,
                                    selectedContainerColor = Accent500.copy(alpha = 0.16f),
                                    selectedLabelColor = Accent300,
                                ),
                                border = null,
                            )
                        }
                    }
                }
                OutlinedTextField(
                    value = ruleName,
                    onValueChange = { ruleName = it },
                    label = { Text("Nama aturan") },
                    modifier = Modifier.fillMaxWidth(),
                    colors = appTextFieldColors(),
                )
                OutlinedTextField(
                    value = ssid,
                    onValueChange = { ssid = it },
                    label = { Text("SSID WiFi diizinkan (opsional)") },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    colors = appTextFieldColors(),
                )
                OutlinedTextField(
                    value = cidr,
                    onValueChange = { cidr = it },
                    label = { Text("IP/CIDR diizinkan (opsional)") },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    colors = appTextFieldColors(),
                )
                OutlinedTextField(
                    value = maxDistance,
                    onValueChange = { maxDistance = it },
                    label = { Text("Jarak BLE maksimum, meter (opsional)") },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    colors = appTextFieldColors(),
                )
                AppButton(
                    text = "Simpan Aturan",
                    enabled = !busy,
                    loading = busy,
                    onClick = {
                        val orgId = selectedSiteId ?: run {
                            statusMessage = "Pilih site untuk aturan ini"
                            return@AppButton
                        }
                        if (ruleName.isBlank()) {
                            statusMessage = "Nama aturan wajib diisi"
                            return@AppButton
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
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                )

                statusMessage?.let {
                    Text(it, color = Base300, modifier = Modifier.padding(top = 8.dp))
                }
            }

            Text(
                "Daftar Aturan",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = Base50,
                modifier = Modifier.padding(top = 20.dp, bottom = 8.dp),
            )

            LazyColumn {
                items(rules, key = { it.id }) { rule ->
                    SectionCard(modifier = Modifier.padding(vertical = 4.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(rule.ruleName, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = Base50)
                                    Spacer(modifier = Modifier.width(8.dp))
                                    StatusBadge(
                                        if (rule.isActive) "Aktif" else "Nonaktif",
                                        if (rule.isActive) BadgeVariant.Success else BadgeVariant.Neutral,
                                    )
                                }
                                rule.allowedSsid?.let { Text("WiFi: $it", style = MaterialTheme.typography.bodySmall, color = Base400) }
                                rule.allowedIpCidr?.let { Text("IP: $it", style = MaterialTheme.typography.bodySmall, color = Base400) }
                                rule.maxDistanceMeters?.let { Text("Jarak BLE maks: $it m", style = MaterialTheme.typography.bodySmall, color = Base400) }
                            }
                            Switch(
                                checked = rule.isActive,
                                onCheckedChange = {
                                    scope.launch {
                                        apiClient.updateGeofenceRule(rule.id, it)
                                        refreshTick++
                                    }
                                },
                                colors = SwitchDefaults.colors(
                                    checkedThumbColor = Base950,
                                    checkedTrackColor = Accent500,
                                    uncheckedThumbColor = Base400,
                                    uncheckedTrackColor = Base800,
                                    uncheckedBorderColor = Base600,
                                ),
                            )
                            IconButton(onClick = {
                                scope.launch {
                                    apiClient.deleteGeofenceRule(rule.id)
                                    refreshTick++
                                }
                            }) { Icon(Icons.Filled.Delete, "Hapus", tint = Danger400) }
                        }
                    }
                }
            }
        }
    }
}
