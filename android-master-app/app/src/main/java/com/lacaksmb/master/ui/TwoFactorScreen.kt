package com.lacaksmb.master.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavHostController
import com.lacaksmb.master.data.ApiClient
import com.lacaksmb.master.data.ApiResult
import com.lacaksmb.master.data.SessionStore
import com.lacaksmb.master.data.UserProfile
import com.lacaksmb.master.service.MasterAnchorService
import com.lacaksmb.master.ui.components.AppButton
import com.lacaksmb.master.ui.components.SectionCard
import com.lacaksmb.master.ui.components.appTextFieldColors
import com.lacaksmb.master.ui.theme.Base400
import com.lacaksmb.master.ui.theme.Base50
import com.lacaksmb.master.ui.theme.Danger400
import org.json.JSONObject
import kotlinx.coroutines.launch

@Composable
fun TwoFactorScreen(apiClient: ApiClient, sessionStore: SessionStore, navController: NavHostController) {
    var code by remember { mutableStateOf("") }
    var errorText by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val isSetup = AuthFlowState.isSetupMode
    val context = LocalContext.current

    fun handleAuthData(data: JSONObject?) {
        val token = data?.optString("access_token")
        val userJson = data?.optJSONObject("user")
        if (token.isNullOrBlank() || userJson == null) {
            errorText = "Respons server tidak lengkap"
            return
        }
        val user = UserProfile.fromJson(userJson)
        sessionStore.saveSession(token, user)
        MasterAnchorService.start(context.applicationContext)
        AuthFlowState.clear()
        navController.navigate(Routes.DEVICE_LIST) {
            popUpTo(Routes.LOGIN) { inclusive = true }
        }
    }

    Scaffold { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                "Verifikasi 2FA",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                color = Base50,
            )
            Text(
                if (isSetup) {
                    "Baru pertama kali login — scan QR dari web dashboard dengan Google Authenticator, lalu masukkan kode 6 digit di sini. Kode manual: ${AuthFlowState.secretManualEntry.orEmpty()}"
                } else {
                    "Masukkan kode dari aplikasi authenticator Anda"
                },
                style = MaterialTheme.typography.bodyMedium,
                color = Base400,
                modifier = Modifier.padding(top = 4.dp, bottom = 20.dp),
            )

            SectionCard {
                OutlinedTextField(
                    value = code,
                    onValueChange = { if (it.length <= 6) code = it; errorText = null },
                    label = { Text("Kode 6 digit") },
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    colors = appTextFieldColors(),
                )

                errorText?.let {
                    Text(it, color = Danger400, modifier = Modifier.padding(top = 12.dp))
                }

                AppButton(
                    text = if (loading) "Memproses..." else "Verifikasi",
                    loading = loading,
                    enabled = !loading,
                    onClick = {
                        if (code.length != 6) {
                            errorText = "Kode harus 6 digit"
                            return@AppButton
                        }
                        loading = true
                        scope.launch {
                            val result = if (isSetup) {
                                apiClient.confirmTwoFactorSetup(AuthFlowState.setupToken.orEmpty(), code)
                            } else {
                                apiClient.verifyTwoFactor(AuthFlowState.challengeToken.orEmpty(), code)
                            }
                            when (result) {
                                is ApiResult.Ok -> handleAuthData(result.data)
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
