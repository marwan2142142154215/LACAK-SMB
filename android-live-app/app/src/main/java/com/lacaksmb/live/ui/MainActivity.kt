package com.lacaksmb.live.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.lacaksmb.live.data.ApiClient
import com.lacaksmb.live.data.SessionStore
import com.lacaksmb.live.ui.theme.LacakLiveTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val sessionStore = SessionStore(applicationContext)
        val apiClient = ApiClient(sessionStore)

        setContent {
            LacakLiveTheme {
                LiveApp(sessionStore = sessionStore, apiClient = apiClient)
            }
        }
    }
}

@Composable
fun LiveApp(sessionStore: SessionStore, apiClient: ApiClient) {
    val navController = rememberNavController()
    val startDestination = if (sessionStore.isLoggedIn()) Routes.LIVE else Routes.LOGIN

    NavHost(navController = navController, startDestination = startDestination) {
        composable(Routes.LOGIN) {
            LoginScreen(apiClient = apiClient, sessionStore = sessionStore, navController = navController)
        }
        composable(Routes.TWO_FACTOR) {
            TwoFactorScreen(apiClient = apiClient, sessionStore = sessionStore, navController = navController)
        }
        composable(Routes.LIVE) {
            LiveScreen(apiClient = apiClient, sessionStore = sessionStore, navController = navController)
        }
    }
}

object Routes {
    const val LOGIN = "login"
    const val TWO_FACTOR = "two_factor"
    const val LIVE = "live"
}
