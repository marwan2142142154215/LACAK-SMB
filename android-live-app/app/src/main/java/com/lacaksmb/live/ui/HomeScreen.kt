package com.lacaksmb.live.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.EventAvailable
import androidx.compose.material.icons.filled.EventBusy
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.lacaksmb.live.data.ApiClient
import com.lacaksmb.live.data.SessionStore
import com.lacaksmb.live.service.BroadcastStatus
import com.lacaksmb.live.service.LiveBroadcastState
import com.lacaksmb.live.ui.components.AppTopBar
import com.lacaksmb.live.ui.theme.Accent500
import com.lacaksmb.live.ui.theme.Base300
import com.lacaksmb.live.ui.theme.Base400
import com.lacaksmb.live.ui.theme.Base50
import com.lacaksmb.live.ui.theme.Base800
import com.lacaksmb.live.ui.theme.Base900
import com.lacaksmb.live.ui.theme.Danger400
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class HomeTab(val label: String, val icon: ImageVector, val path: String?) {
    Live("Live", Icons.Filled.Videocam, null),
    Chat("Chat", Icons.AutoMirrored.Filled.Chat, "/chat"),
    Briefing("Briefing", Icons.Filled.Groups, "/briefing"),
    Attendance("Absensi", Icons.Filled.EventAvailable, "/absensi"),
    More("Lainnya", Icons.Filled.MoreHoriz, null),
}

private data class MoreItem(val label: String, val icon: ImageVector, val path: String)

private val MORE_ITEMS = listOf(
    MoreItem("Izin & cuti", Icons.Filled.EventBusy, "/izin"),
    MoreItem("Pengumuman", Icons.Filled.Campaign, "/pengumuman"),
)

/** Peringatan baru dari atasan dicek tiap 30 detik selama aplikasi terbuka. */
private const val WARNING_POLL_MS = 30_000L

/**
 * Layar utama setelah login: Live (siaran native, tetap jalan di latar belakang) + menu kerja harian
 * dari dashboard web (WebView, tanpa memperbesar APK). Tab terakhir yang dibuka tidak dimuat ulang.
 */
@Composable
fun HomeScreen(apiClient: ApiClient, sessionStore: SessionStore, navController: NavHostController) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val web = remember { DashboardWeb(context, sessionStore) }
    var tab by rememberSaveable { mutableStateOf(HomeTab.Live) }
    var morePath by rememberSaveable { mutableStateOf<String?>(null) }
    val status by LiveBroadcastState.status.collectAsStateWithLifecycle()
    val warnings = remember { mutableStateListOf<com.lacaksmb.live.data.StaffWarning>() }

    LaunchedEffect(Unit) {
        while (true) {
            val pending = apiClient.pendingWarnings()
            pending.filter { item -> warnings.none { it.id == item.id } }.forEach { warnings.add(it) }
            delay(WARNING_POLL_MS)
        }
    }

    // Tombol kembali dari tab lain kembali ke Live dulu, baru keluar aplikasi.
    BackHandler(enabled = tab != HomeTab.Live && !web.canGoBack) {
        if (tab == HomeTab.More && morePath != null) morePath = null else tab = HomeTab.Live
    }

    fun logout() {
        scope.launch { apiClient.logout() }
        sessionStore.clear()
        DashboardWeb.clearSession()
        navController.navigate(Routes.LOGIN) { popUpTo(0) }
    }

    Scaffold(
        bottomBar = {
            NavigationBar(containerColor = Base900, tonalElevation = 0.dp) {
                HomeTab.entries.forEach { item ->
                    NavigationBarItem(
                        selected = tab == item,
                        onClick = {
                            if (tab == item && item == HomeTab.More) morePath = null
                            tab = item
                        },
                        icon = { Icon(item.icon, contentDescription = null) },
                        label = { Text(item.label) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = Accent500,
                            selectedTextColor = Accent500,
                            indicatorColor = Accent500.copy(alpha = 0.12f),
                            unselectedIconColor = Base400,
                            unselectedTextColor = Base400,
                        ),
                    )
                }
            }
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(bottom = padding.calculateBottomPadding())) {
            val webPath = when (tab) {
                HomeTab.More -> morePath
                else -> tab.path
            }
            when {
                tab == HomeTab.Live -> LiveScreen(apiClient = apiClient, sessionStore = sessionStore, navController = navController)
                webPath != null -> Column(Modifier.fillMaxSize()) {
                    if (tab == HomeTab.More) {
                        AppTopBar(
                            title = MORE_ITEMS.firstOrNull { it.path == webPath }?.label ?: "Lainnya",
                            onBack = { morePath = null },
                        )
                    }
                    // Tab web tanpa bar atas: jangan tertutup status bar (edge-to-edge).
                    val inset = if (tab == HomeTab.More) Modifier else Modifier.statusBarsPadding()
                    DashboardWebPage(web = web, path = webPath, modifier = Modifier.weight(1f).then(inset))
                }
                else -> MoreMenu(
                    name = sessionStore.user()?.name,
                    canLogout = status is BroadcastStatus.Idle,
                    onOpen = { morePath = it },
                    onLogout = ::logout,
                )
            }
        }
    }

    warnings.firstOrNull()?.let { warning ->
        AlertDialog(
            onDismissRequest = {},
            icon = { Icon(Icons.Filled.WarningAmber, contentDescription = null, tint = Danger400) },
            title = { Text("Peringatan: ${warning.levelLabel}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(warning.message, color = Base50)
                    warning.issuerName?.let { Text("Dari $it", color = Base400, style = MaterialTheme.typography.bodySmall) }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    warnings.remove(warning)
                    scope.launch { apiClient.acknowledgeWarning(warning.id) }
                }) { Text("Saya mengerti", color = Accent500, fontWeight = FontWeight.SemiBold) }
            },
            containerColor = Base900,
        )
    }
}

@Composable
private fun MoreMenu(name: String?, canLogout: Boolean, onOpen: (String) -> Unit, onLogout: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        AppTopBar(title = name ?: "Lainnya")
        MORE_ITEMS.forEach { item ->
            MoreRow(item.label, item.icon, onClick = { onOpen(item.path) })
            HorizontalDivider(color = Base800)
        }
        MoreRow(
            label = if (canLogout) "Keluar" else "Keluar (selesaikan kerja dulu)",
            icon = Icons.AutoMirrored.Filled.Logout,
            enabled = canLogout,
            danger = true,
            onClick = onLogout,
        )
    }
}

@Composable
private fun MoreRow(label: String, icon: ImageVector, onClick: () -> Unit, enabled: Boolean = true, danger: Boolean = false) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        val color = when {
            !enabled -> Base400
            danger -> Danger400
            else -> Base50
        }
        Icon(icon, contentDescription = null, tint = if (danger && enabled) Danger400 else Base300, modifier = Modifier.size(22.dp))
        Text(label, color = color, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        if (!danger) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = Base400)
    }
}
