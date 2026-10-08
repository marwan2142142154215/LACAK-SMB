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
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
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
            TopAppBar(
                title = { Text("Download APK") },
                navigationIcon = {
                    IconButton(onClick = { navController.popBackStack() }) {
                        Icon(Icons.Filled.ArrowBack, "Kembali")
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            Text(
                "Build APK sungguhan di server dengan kode site ditanam otomatis untuk site Anda, lalu unduh.",
                style = MaterialTheme.typography.bodyMedium,
            )

            Spacer(modifier = Modifier.height(16.dp))

            Row {
                FilterChip(
                    selected = apkType == "tracker",
                    onClick = { apkType = "tracker" },
                    label = { Text("APK Pelacak (perangkat target)") },
                )
                Spacer(modifier = Modifier.width(8.dp))
                FilterChip(
                    selected = apkType == "master",
                    onClick = { apkType = "master" },
                    label = { Text("APK Master") },
                )
                Spacer(modifier = Modifier.width(8.dp))
                FilterChip(
                    selected = apkType == "server",
                    onClick = { apkType = "server" },
                    label = { Text("Server (.exe)") },
                )
            }

            OutlinedTextField(
                value = version,
                onValueChange = { version = it },
                label = { Text("Versi") },
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            )

            Button(
                onClick = {
                    val orgId = sessionStore.user()?.organizationId
                    if (orgId == null) {
                        statusText = "Akun Anda tidak terikat ke site manapun"
                        return@Button
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
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
            ) {
                Icon(Icons.Filled.Download, null, modifier = Modifier.height(18.dp))
                Text(" Build & Unduh")
            }

            if (busy) {
                Spacer(modifier = Modifier.height(16.dp))
                CircularProgressIndicator()
            }

            statusText?.let {
                Text(it, modifier = Modifier.padding(top = 16.dp))
            }

            downloadUrl?.let { url ->
                Button(
                    onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) },
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                ) {
                    Text("Unduh Sekarang")
                }
            }
        }
    }
}
