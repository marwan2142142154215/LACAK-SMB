package com.lacaksmb.master.ui

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Block
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.lacaksmb.master.data.ApiClient
import com.lacaksmb.master.data.ApiResult
import com.lacaksmb.master.data.ConsentDocument
import com.lacaksmb.master.data.SessionStore
import kotlinx.coroutines.launch
import java.io.File
import java.text.SimpleDateFormat
import java.util.Locale

private val SIGNER_ROLES = listOf("parent", "hr_staff", "device_owner")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConsentScreen(apiClient: ApiClient, sessionStore: SessionStore, navController: NavHostController) {
    val context = LocalContext.current
    var documents by remember { mutableStateOf<List<ConsentDocument>>(emptyList()) }
    var refreshTick by remember { mutableStateOf(0) }
    var statusMessage by remember { mutableStateOf<String?>(null) }

    var subjectName by remember { mutableStateOf("") }
    var signerName by remember { mutableStateOf("") }
    var signerRole by remember { mutableStateOf(SIGNER_ROLES.first()) }
    var roleMenuExpanded by remember { mutableStateOf(false) }
    var pickedFileUri by remember { mutableStateOf<Uri?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        pickedFileUri = uri
    }

    LaunchedEffect(refreshTick) {
        when (val result = apiClient.listConsentDocuments(sessionStore.user()?.organizationId)) {
            is ApiResult.Ok -> {
                val items = result.data?.optJSONArray("items")
                documents = (0 until (items?.length() ?: 0)).map { ConsentDocument.fromJson(items!!.getJSONObject(it)) }
            }
            is ApiResult.Fail -> statusMessage = result.message
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Dokumen Consent") },
                navigationIcon = {
                    IconButton(onClick = { navController.popBackStack() }) {
                        Icon(Icons.Filled.ArrowBack, "Kembali")
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            Text("Unggah Dokumen Baru", style = MaterialTheme.typography.titleMedium)

            OutlinedTextField(
                value = subjectName,
                onValueChange = { subjectName = it },
                label = { Text("Nama subjek (staf/anak)") },
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
            OutlinedTextField(
                value = signerName,
                onValueChange = { signerName = it },
                label = { Text("Nama penanda tangan") },
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )

            Box(modifier = Modifier.padding(top = 8.dp)) {
                OutlinedTextField(
                    value = signerRole,
                    onValueChange = {},
                    readOnly = true,
                    label = { Text("Peran penanda tangan") },
                    trailingIcon = {
                        IconButton(onClick = { roleMenuExpanded = true }) {
                            Icon(Icons.Filled.ArrowDropDown, "Pilih peran")
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                DropdownMenu(
                    expanded = roleMenuExpanded,
                    onDismissRequest = { roleMenuExpanded = false },
                ) {
                    SIGNER_ROLES.forEach { role ->
                        DropdownMenuItem(
                            text = { Text(role) },
                            onClick = { signerRole = role; roleMenuExpanded = false },
                        )
                    }
                }
            }

            OutlinedButton(
                onClick = { filePicker.launch("*/*") },
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            ) {
                Text(if (pickedFileUri == null) "Pilih File (PDF/JPG/PNG)" else "File dipilih: ${pickedFileUri}")
            }

            Button(
                onClick = {
                    val orgId = sessionStore.user()?.organizationId
                    val uri = pickedFileUri
                    if (orgId == null || subjectName.isBlank() || signerName.isBlank() || uri == null) {
                        statusMessage = "Lengkapi semua field dan pilih file dulu"
                        return@Button
                    }
                    busy = true
                    scope.launch {
                        val mimeType = context.contentResolver.getType(uri) ?: "application/octet-stream"
                        val extension = when {
                            mimeType.contains("pdf") -> "pdf"
                            mimeType.contains("png") -> "png"
                            else -> "jpg"
                        }
                        val tempFile = File(context.cacheDir, "consent-upload.$extension")
                        context.contentResolver.openInputStream(uri)?.use { input ->
                            tempFile.outputStream().use { output -> input.copyTo(output) }
                        }
                        val today = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(java.util.Date())
                        val result = apiClient.createConsentDocument(
                            organizationId = orgId,
                            subjectName = subjectName.trim(),
                            signerName = signerName.trim(),
                            signerRole = signerRole,
                            signedAt = today,
                            validUntil = null,
                            documentFile = tempFile,
                            documentMimeType = mimeType,
                        )
                        when (result) {
                            is ApiResult.Ok -> {
                                statusMessage = "Dokumen berhasil diunggah"
                                subjectName = ""; signerName = ""; pickedFileUri = null
                                refreshTick++
                            }
                            is ApiResult.Fail -> statusMessage = result.message
                        }
                        tempFile.delete()
                        busy = false
                    }
                },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            ) { Text("Unggah") }

            statusMessage?.let { Text(it, modifier = Modifier.padding(top = 8.dp)) }

            Text("Daftar Dokumen", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 20.dp, bottom = 8.dp))

            LazyColumn {
                items(documents, key = { it.id }) { doc ->
                    Card(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(12.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(doc.subjectName, style = MaterialTheme.typography.titleSmall)
                                Text("Ditandatangani: ${doc.signerName} (${doc.signerRole})", style = MaterialTheme.typography.bodySmall)
                                Text(
                                    if (doc.isActive) "Aktif" else "Tidak aktif/dicabut",
                                    style = MaterialTheme.typography.bodySmall,
                                    fontStyle = if (doc.isActive) FontStyle.Normal else FontStyle.Italic,
                                )
                                doc.documentUrl?.let { url ->
                                    Text(
                                        "Lihat dokumen",
                                        color = MaterialTheme.colorScheme.primary,
                                        style = MaterialTheme.typography.bodySmall,
                                        modifier = Modifier
                                            .padding(top = 2.dp)
                                            .clickable {
                                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                                            },
                                    )
                                }
                            }
                            if (doc.isActive) {
                                IconButton(onClick = {
                                    scope.launch {
                                        apiClient.revokeConsentDocument(doc.id)
                                        refreshTick++
                                    }
                                }) { Icon(Icons.Filled.Block, "Cabut") }
                            }
                        }
                    }
                }
            }
        }
    }
}
