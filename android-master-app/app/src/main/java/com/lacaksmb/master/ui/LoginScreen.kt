package com.lacaksmb.master.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.lacaksmb.master.data.ApiClient
import com.lacaksmb.master.data.ApiResult
import com.lacaksmb.master.ui.components.AppButton
import com.lacaksmb.master.ui.components.AppButtonVariant
import com.lacaksmb.master.ui.components.SectionCard
import com.lacaksmb.master.ui.components.appTextFieldColors
import com.lacaksmb.master.ui.theme.Accent400
import com.lacaksmb.master.ui.theme.Base400
import com.lacaksmb.master.ui.theme.Base50
import com.lacaksmb.master.ui.theme.Danger400
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
            Text(
                "Lacak SMB Master",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                color = Base50,
            )
            Text(
                "Masuk untuk mengelola & mencari device",
                style = MaterialTheme.typography.bodyMedium,
                color = Base400,
                modifier = Modifier.padding(top = 4.dp, bottom = 20.dp),
            )

            SectionCard {
                Text(
                    "Satu APK untuk semua site — akses mengikuti akun yang masuk",
                    style = MaterialTheme.typography.labelSmall,
                    color = Accent400,
                    modifier = Modifier.padding(bottom = 16.dp),
                )

                OutlinedTextField(
                    value = username,
                    onValueChange = { username = it; errorText = null },
                    label = { Text("Username") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    colors = appTextFieldColors(),
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it; errorText = null },
                    label = { Text("Password") },
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    colors = appTextFieldColors(),
                )

                errorText?.let {
                    Text(it, color = Danger400, modifier = Modifier.padding(top = 12.dp))
                }

                AppButton(
                    text = if (loading) "Memproses..." else "Masuk",
                    loading = loading,
                    enabled = !loading,
                    onClick = {
                        if (username.isBlank() || password.isBlank()) {
                            errorText = "Username dan password wajib diisi"
                            return@AppButton
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
                    modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
                )
            }
        }
    }
}
