package com.lacaksmb.master.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.lacaksmb.master.data.ApiClient
import com.lacaksmb.master.data.ApiResult
import com.lacaksmb.master.data.SessionStore
import com.lacaksmb.master.ui.components.AppButton
import com.lacaksmb.master.ui.components.AppButtonVariant
import com.lacaksmb.master.ui.components.AppTopBar
import com.lacaksmb.master.ui.components.SectionCard
import com.lacaksmb.master.ui.components.appTextFieldColors
import com.lacaksmb.master.ui.theme.Accent500
import com.lacaksmb.master.ui.theme.Base300
import com.lacaksmb.master.ui.theme.Base400
import com.lacaksmb.master.ui.theme.Base600
import com.lacaksmb.master.ui.theme.Base800
import com.lacaksmb.master.ui.theme.Base900
import com.lacaksmb.master.ui.theme.Base950
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val POLL_INTERVAL_MS = 4_000L
private const val POLL_MAX_TRIES = 30 // ~2 menit

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DownloadApkScreen(apiClient: ApiClient, sessionStore: SessionStore, navController: NavHostController) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var apkType by remember { mutableStateOf("tracker") }
    var version by remember { mutableStateOf("1.0.0") }
    var busy by remember { mutableStateOf(false) }
    var statusText by remember { mutableStateOf<String?>(null) }
    var downloadUrl by remember { mutableStateOf<String?>(null) }

    Scaffold(
        topBar = {
            AppTopBar(title = "Download APK", onBack = { navController.popBackStack() })
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            SectionCard {
                Text(
                    "Build APK sungguhan di server. APK Pelacak per site (kode site ditanam otomatis), APK Master universal — akses ditentukan akun yang masuk.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Base300,
                )

                Spacer(modifier = Modifier.height(16.dp))

                Row {
                    FilterChip(
                        selected = apkType == "tracker",
                        onClick = { apkType = "tracker" },
                        label = { Text("APK Pelacak (perangkat target)") },
                        colors = apkFilterChipColors(),
                        border = null,
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    FilterChip(
                        selected = apkType == "master",
                        onClick = { apkType = "master" },
                        label = { Text("APK Master") },
                        colors = apkFilterChipColors(),
                        border = null,
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    FilterChip(
                        selected = apkType == "server",
                        onClick = { apkType = "server" },
                        label = { Text("Server (.exe)") },
                        colors = apkFilterChipColors(),
                        border = null,
                    )
                }

                OutlinedTextField(
                    value = version,
                    onValueChange = { version = it },
                    label = { Text("Versi") },
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                    colors = appTextFieldColors(),
                )

                AppButton(
                    text = "Build & Unduh",
                    icon = Icons.Filled.Download,
                    enabled = !busy,
                    loading = busy,
                    onClick = {
                        val orgId = sessionStore.user()?.organizationId
                        if (orgId == null) {
                            statusText = "Akun Anda tidak terikat ke site manapun"
                            return@AppButton
                        }
                        busy = true
                        statusText = "Memulai build..."
                        downloadUrl = null
                        scope.launch {
                            val startResult = apiClient.generateApkBuild(orgId, apkType, version.ifBlank { "1.0.0" })
                            val buildId = (startResult as? ApiResult.Ok)?.data?.optInt("id")
                            if (startResult !is ApiResult.Ok || buildId == null) {
                                statusText = (startResult as? ApiResult.Fail)?.message ?: "Gagal memulai build"
                                busy = false
                                return@launch
                            }

                            statusText = "Build berjalan, biasanya 1-2 menit..."
                            var finished = false
                            for (attempt in 0 until POLL_MAX_TRIES) {
                                delay(POLL_INTERVAL_MS)
                                val pollResult = apiClient.getApkBuild(buildId)
                                val data = (pollResult as? ApiResult.Ok)?.data ?: continue
                                when (data.optString("status")) {
                                    "success" -> {
                                        downloadUrl = data.optString("download_url")
                                        statusText = "Build selesai — tekan Unduh di bawah"
                                        finished = true
                                    }
                                    "failed" -> {
                                        statusText = "Build gagal: ${data.optString("build_log").takeLast(300)}"
                                        finished = true
                                    }
                                }
                                if (finished) break
                            }
                            if (!finished) {
                                statusText = "Build masih berjalan — cek lagi nanti lewat dashboard web"
                            }
                            busy = false
                        }
                    },
                    modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
                )

                if (busy) {
                    Spacer(modifier = Modifier.height(16.dp))
                    CircularProgressIndicator(color = Accent500)
                }

                statusText?.let {
                    Text(it, color = Base300, modifier = Modifier.padding(top = 16.dp))
                }

                downloadUrl?.let { url ->
                    AppButton(
                        text = "Unduh Sekarang",
                        variant = AppButtonVariant.Outline,
                        onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) },
                        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun apkFilterChipColors() = FilterChipDefaults.filterChipColors(
    containerColor = Base900,
    labelColor = Base400,
    selectedContainerColor = Accent500.copy(alpha = 0.16f),
    selectedLabelColor = com.lacaksmb.master.ui.theme.Accent300,
    iconColor = Base400,
)
