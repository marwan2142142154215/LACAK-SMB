package com.lacaksmb.master.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.lacaksmb.master.data.ApiClient
import com.lacaksmb.master.data.SessionStore
import com.lacaksmb.master.service.MasterAnchorService
import com.lacaksmb.master.ui.theme.LacakMasterTheme

class MainActivity : ComponentActivity() {

    private lateinit var sessionStore: SessionStore
    private lateinit var apiClient: ApiClient

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        sessionStore = SessionStore(applicationContext)
        apiClient = ApiClient(sessionStore)

        // Sesi lama yang masih tersimpan (app dibuka ulang, bukan login baru)
        // -- MasterAnchorService sendiri yang mengecek izin devices.unlock
        // dan berhenti diam-diam kalau tidak berwenang/token sudah mati.
        if (sessionStore.isLoggedIn()) {
            MasterAnchorService.start(applicationContext)
        }

        setContent {
            LacakMasterTheme {
                MasterApp(sessionStore = sessionStore, apiClient = apiClient)
            }
        }
    }
}

@Composable
fun MasterApp(sessionStore: SessionStore, apiClient: ApiClient) {
    val navController = rememberNavController()
    val startDestination = if (sessionStore.isLoggedIn()) Routes.DEVICE_LIST else Routes.LOGIN

    NavHost(navController = navController, startDestination = startDestination, modifier = Modifier) {
        composable(Routes.LOGIN) {
            LoginScreen(apiClient = apiClient, navController = navController)
        }
        composable(Routes.TWO_FACTOR) {
            TwoFactorScreen(apiClient = apiClient, sessionStore = sessionStore, navController = navController)
        }
        composable(Routes.DEVICE_LIST) {
            DeviceListScreen(apiClient = apiClient, sessionStore = sessionStore, navController = navController)
        }
        composable(Routes.DEVICE_DETAIL) { backStackEntry ->
            val deviceId = backStackEntry.arguments?.getString("deviceId")?.toIntOrNull() ?: 0
            DeviceDetailScreen(deviceId = deviceId, apiClient = apiClient, navController = navController)
        }
        composable(Routes.RADAR) {
            RadarScreen(apiClient = apiClient, navController = navController)
        }
        composable(Routes.GEOFENCE) {
            GeofenceScreen(apiClient = apiClient, sessionStore = sessionStore, navController = navController)
        }
        composable(Routes.CONSENT) {
            ConsentScreen(apiClient = apiClient, sessionStore = sessionStore, navController = navController)
        }
        composable(Routes.DOWNLOAD_APK) {
            DownloadApkScreen(apiClient = apiClient, sessionStore = sessionStore, navController = navController)
        }
    }
}

object Routes {
    const val LOGIN = "login"
    const val TWO_FACTOR = "two_factor"
    const val DEVICE_LIST = "device_list"
    const val DEVICE_DETAIL = "device_detail/{deviceId}"
    const val RADAR = "radar"
    const val GEOFENCE = "geofence"
    const val CONSENT = "consent"
    const val DOWNLOAD_APK = "download_apk"

    fun deviceDetail(id: Int) = "device_detail/$id"
}

fun NavHostController.goTo(route: String) {
    navigate(route)
}
