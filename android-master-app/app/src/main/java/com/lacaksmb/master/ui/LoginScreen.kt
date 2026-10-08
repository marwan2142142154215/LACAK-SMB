package com.lacaksmb.master.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.lacaksmb.master.data.ApiClient
import com.lacaksmb.master.data.ApiResult
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginScreen(apiClient: ApiClient, navController: NavHostController) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Scaffold { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Text("Lacak SMB Master", style = MaterialTheme.typography.headlineMedium)
            Text(
                "Masuk untuk mengelola & mencari device",
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                "Satu APK untuk semua site — akses mengikuti akun yang masuk",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(bottom = 24.dp, top = 4.dp),
            )

            OutlinedTextField(
                value = username,
                onValueChange = { username = it; errorText = null },
                label = { Text("Username") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            OutlinedTextField(
                value = password,
                onValueChange = { password = it; errorText = null },
                label = { Text("Password") },
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
            )

            errorText?.let {
                Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp))
            }

            Button(
                onClick = {
                    if (username.isBlank() || password.isBlank()) {
                        errorText = "Username dan password wajib diisi"
                        return@Button
                    }
                    loading = true
                    scope.launch {
                        when (val result = apiClient.login(username.trim(), password)) {
                            is ApiResult.Ok -> {
                                val data = result.data
                                when {
                                    data?.optBoolean("requires_2fa_setup") == true -> {
                                        AuthFlowState.clear()
                                        AuthFlowState.isSetupMode = true
                                        AuthFlowState.setupToken = data.optString("setup_token")
                                        AuthFlowState.qrCodeSvg = data.optString("qr_code_svg")
                                        AuthFlowState.secretManualEntry = data.optString("secret_manual_entry")
                                        navController.navigate(Routes.TWO_FACTOR)
                                    }
                                    data?.optBoolean("requires_2fa") == true -> {
                                        AuthFlowState.clear()
                                        AuthFlowState.isSetupMode = false
                                        AuthFlowState.challengeToken = data.optString("challenge_token")
                                        navController.navigate(Routes.TWO_FACTOR)
                                    }
                                    else -> errorText = "Respons server tidak dikenali"
                                }
                            }
                            is ApiResult.Fail -> errorText = result.message
                        }
                        loading = false
                    }
                },
                enabled = !loading,
                modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
            ) {
                if (loading) {
                    CircularProgressIndicator(
                        modifier = Modifier.padding(end = 8.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                }
                Text("Masuk")
            }
        }
    }
}
