package com.lacaksmb.live.ui

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.ScreenShare
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.lacaksmb.live.data.ApiClient
import com.lacaksmb.live.data.SessionStore
import com.lacaksmb.live.service.BroadcastStatus
import com.lacaksmb.live.service.LiveBroadcastService
import com.lacaksmb.live.service.LiveBroadcastState
import com.lacaksmb.live.service.MicState
import com.lacaksmb.live.ui.components.AppButton
import com.lacaksmb.live.ui.components.AppButtonVariant
import com.lacaksmb.live.ui.components.AppTopBar
import com.lacaksmb.live.ui.components.BadgeVariant
import com.lacaksmb.live.ui.components.SectionCard
import com.lacaksmb.live.ui.components.StatusBadge
import com.lacaksmb.live.ui.theme.Base300
import com.lacaksmb.live.ui.theme.Base400
import com.lacaksmb.live.ui.theme.Base50
import com.lacaksmb.live.ui.theme.Base950
import com.lacaksmb.live.ui.theme.Danger400
import com.lacaksmb.live.ui.theme.Warning400
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun LiveScreen(apiClient: ApiClient, sessionStore: SessionStore, navController: NavHostController) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val user = remember { sessionStore.user() }
    val status by LiveBroadcastState.status.collectAsStateWithLifecycle()
    val room by LiveBroadcastState.room.collectAsStateWithLifecycle()
    val liveSince by LiveBroadcastState.liveSince.collectAsStateWithLifecycle()
    val micState by LiveBroadcastState.micState.collectAsStateWithLifecycle()
    val screenSharing by LiveBroadcastState.screenSharing.collectAsStateWithLifecycle()
    val faceMissing by LiveBroadcastState.faceMissing.collectAsStateWithLifecycle()
    var permissionError by remember { mutableStateOf<String?>(null) }

    val canBroadcast = user?.can("live.broadcast") == true
    val busy = status is BroadcastStatus.Connecting || status is BroadcastStatus.Stopping
    val active = status !is BroadcastStatus.Idle

    // Izin berbagi layar (MediaProjection). Hasilnya sekali pakai, langsung
    // diserahkan ke service. Ditolak = siaran tetap jalan tanpa layar
    // (Screen off: tidak dihitung kerja) dan tombol Bagikan layar muncul.
    val screenLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data.takeIf { result.resultCode == Activity.RESULT_OK }
        val app = context.applicationContext
        when {
            active && data != null -> LiveBroadcastService.shareScreen(app, data)
            active -> Unit
            else -> LiveBroadcastService.start(app, data)
        }
        if (data == null) {
            permissionError = "Layar tidak dibagikan. Selama layar tidak dibagikan, waktu Anda tidak dihitung sebagai jam kerja."
        }
    }

    fun requestScreenShare() {
        val manager = context.getSystemService(MediaProjectionManager::class.java)
        // Android 14+: paksa pilihan "Seluruh layar", bukan satu aplikasi saja.
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        } else {
            manager.createScreenCaptureIntent()
        }
        screenLauncher.launch(intent)
    }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted[Manifest.permission.CAMERA] == true ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        ) {
            // Izin notifikasi / mikrofon ditolak tidak menghalangi siaran --
            // notifikasinya tidak tampil / siaran tanpa suara.
            requestScreenShare()
        } else {
            permissionError = "Izin kamera dibutuhkan untuk menyiarkan. Buka Pengaturan > Aplikasi > Lacak SMB Live > Izin."
        }
    }

    fun startWork() {
        permissionError = null
        LiveBroadcastState.clearError()
        val needed = buildList {
            add(Manifest.permission.CAMERA)
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED }

        if (needed.isEmpty()) {
            requestScreenShare()
        } else {
            permissionLauncher.launch(needed.toTypedArray())
        }
    }

    Scaffold(
        topBar = {
            AppTopBar(
                title = "Live Kerja",
                actions = {
                    IconButton(
                        enabled = !active,
                        onClick = {
                            scope.launch { apiClient.logout() }
                            sessionStore.clear()
                            navController.navigate(Routes.LOGIN) { popUpTo(0) }
                        },
                    ) { Icon(Icons.AutoMirrored.Filled.Logout, "Keluar", tint = Base300) }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SectionCard(
                title = user?.name ?: "Staf",
                subtitle = "Siaran layar HP & kamera depan ke atasan",
                actions = { StatusBadge(statusLabel(status), statusVariant(status)) },
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .aspectRatio(3f / 4f)
                        .clip(RoundedCornerShape(12.dp))
                        .background(Base950),
                    contentAlignment = Alignment.Center,
                ) {
                    val currentRoom = room
                    if (currentRoom != null && status is BroadcastStatus.Live) {
                        LocalCameraPreview(currentRoom)
                    } else {
                        Icon(
                            if (active) Icons.Filled.Videocam else Icons.Filled.VideocamOff,
                            contentDescription = null,
                            tint = Base400,
                        )
                    }
                }

                liveSince?.let { since -> LiveDuration(since) }

                Text(
                    statusDescription(status),
                    style = MaterialTheme.typography.bodySmall,
                    color = Base400,
                    modifier = Modifier.padding(top = 12.dp),
                )

                val error = permissionError ?: (status as? BroadcastStatus.Idle)?.lastError
                error?.let { Text(it, color = Danger400, modifier = Modifier.padding(top = 12.dp)) }

                if (!canBroadcast) {
                    Text(
                        "Akun ini tidak punya izin menyiarkan Live Kerja. Hubungi admin site.",
                        color = Warning400,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                }

                if (status is BroadcastStatus.Live && faceMissing) {
                    Text(
                        "Wajah Anda tidak terlihat di kamera. Tercatat sebagai Wajah hilang di log kerja sampai wajah terlihat lagi.",
                        style = MaterialTheme.typography.bodySmall,
                        color = Danger400,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                }

                if (status is BroadcastStatus.Live) {
                    ScreenControl(screenSharing, onShare = {
                        permissionError = null
                        requestScreenShare()
                    })
                    MicControl(micState, onToggle = { muted -> LiveBroadcastService.setMicMuted(context.applicationContext, muted) })
                }

                if (active) {
                    AppButton(
                        text = if (status is BroadcastStatus.Stopping) "Menghentikan..." else "Selesai kerja",
                        variant = AppButtonVariant.Danger,
                        loading = status is BroadcastStatus.Stopping,
                        enabled = status !is BroadcastStatus.Stopping,
                        onClick = { LiveBroadcastService.stop(context.applicationContext) },
                        modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
                    )
                } else {
                    AppButton(
                        text = "Mulai kerja",
                        icon = Icons.Filled.Videocam,
                        enabled = canBroadcast && !busy,
                        onClick = { startWork() },
                        modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
                    )
                }
            }

            BatteryOptimizationHint()
        }
    }
}

/** Pratinjau kamera sendiri dari Room milik LiveBroadcastService (cermin, seperti kaca). */
@Composable
private fun LocalCameraPreview(room: Room) {
    var track by remember(room) { mutableStateOf<VideoTrack?>(null) }
    LaunchedEffect(room) {
        // Track kamera terbit sesaat setelah room tersambung.
        while (track == null) {
            track = room.localParticipant.getTrackPublication(Track.Source.CAMERA)?.track as? VideoTrack
            if (track == null) delay(200)
        }
    }

    val renderer = remember(room) { mutableStateOf<TextureViewRenderer?>(null) }
    AndroidView(
        factory = { ctx ->
            TextureViewRenderer(ctx).also {
                room.initVideoRenderer(it)
                it.setMirror(true)
                renderer.value = it
            }
        },
        modifier = Modifier.fillMaxSize(),
    )

    DisposableEffect(track, renderer.value) {
        val currentTrack = track
        val view = renderer.value
        if (currentTrack != null && view != null) currentTrack.addRenderer(view)
        onDispose { if (currentTrack != null && view != null) currentTrack.removeRenderer(view) }
    }
    DisposableEffect(room) {
        onDispose { renderer.value?.release() }
    }
}

/** Status berbagi layar + tombol membagikan lagi (izin baru tiap kali, aturan Android). */
@Composable
private fun ScreenControl(sharing: Boolean, onShare: () -> Unit) {
    Text(
        if (sharing) {
            "Layar HP sedang dibagikan ke atasan."
        } else {
            "Layar belum dibagikan — status Anda Screen off dan tidak dihitung jam kerja."
        },
        style = MaterialTheme.typography.bodySmall,
        color = if (sharing) Base50 else Warning400,
        modifier = Modifier.padding(top = 12.dp),
    )
    if (!sharing) {
        AppButton(
            text = "Bagikan layar",
            icon = Icons.Filled.ScreenShare,
            onClick = onShare,
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
        )
    } else {
        Text(
            "Untuk berhenti berbagi layar, tekan Selesai kerja.",
            style = MaterialTheme.typography.bodySmall,
            color = Base400,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
}

/** Status mikrofon + tombol bisukan. Tanpa izin mikrofon: arahkan ke pengaturan. */
@Composable
private fun MicControl(state: MicState, onToggle: (muted: Boolean) -> Unit) {
    val context = LocalContext.current
    Text(
        when (state) {
            MicState.On -> "Mikrofon menyala — suara Anda terdengar oleh atasan yang mendengarkan."
            MicState.Muted -> "Mikrofon dibisukan — suara Anda tidak disiarkan."
            MicState.None -> "Siaran tanpa suara: izin mikrofon belum diberikan atau mikrofon tidak bisa dibuka."
        },
        style = MaterialTheme.typography.bodySmall,
        color = if (state == MicState.On) Base50 else Base400,
        modifier = Modifier.padding(top = 12.dp),
    )
    when (state) {
        MicState.None -> AppButton(
            text = "Buka pengaturan izin",
            variant = AppButtonVariant.Outline,
            onClick = {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
                runCatching { context.startActivity(intent) }
            },
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
        )
        else -> AppButton(
            text = if (state == MicState.On) "Bisukan mikrofon" else "Nyalakan mikrofon",
            icon = if (state == MicState.On) Icons.Filled.MicOff else Icons.Filled.Mic,
            variant = if (state == MicState.On) AppButtonVariant.Outline else AppButtonVariant.Primary,
            onClick = { onToggle(state == MicState.On) },
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
        )
    }
}

@Composable
private fun LiveDuration(since: Long) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(since) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val total = ((now - since) / 1000).coerceAtLeast(0)
    Text(
        "Durasi siaran %02d:%02d:%02d".format(total / 3600, (total % 3600) / 60, total % 60),
        style = MaterialTheme.typography.titleSmall,
        color = Base50,
        modifier = Modifier.padding(top = 12.dp),
    )
}

/**
 * Beberapa merek HP (Xiaomi, Oppo, Vivo, Samsung mode hemat) tetap
 * mematikan aplikasi di latar belakang walau ada foreground service --
 * minta staf mengecualikan app ini dari optimasi baterai.
 */
@Composable
private fun BatteryOptimizationHint() {
    val context = LocalContext.current
    val powerManager = remember { context.getSystemService(PowerManager::class.java) }
    var ignoring by remember { mutableStateOf(powerManager.isIgnoringBatteryOptimizations(context.packageName)) }

    LaunchedEffect(Unit) {
        while (true) {
            ignoring = powerManager.isIgnoringBatteryOptimizations(context.packageName)
            delay(2_000)
        }
    }
    if (ignoring) return

    SectionCard(title = "Supaya siaran tidak dimatikan HP") {
        Text(
            "Izinkan aplikasi ini berjalan tanpa pembatasan baterai, agar siaran tetap jalan saat layar mati.",
            style = MaterialTheme.typography.bodySmall,
            color = Base400,
        )
        AppButton(
            text = "Buka pengaturan baterai",
            variant = AppButtonVariant.Outline,
            onClick = {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
                runCatching { context.startActivity(intent) }
                    .onFailure { context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
            },
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
        )
    }
}

private fun statusLabel(status: BroadcastStatus): String = when (status) {
    is BroadcastStatus.Idle -> "Tidak live"
    is BroadcastStatus.Connecting -> "Menyambung"
    BroadcastStatus.Live -> "LIVE"
    BroadcastStatus.Stopping -> "Berhenti"
}

private fun statusVariant(status: BroadcastStatus): BadgeVariant = when (status) {
    is BroadcastStatus.Idle -> BadgeVariant.Neutral
    is BroadcastStatus.Connecting, BroadcastStatus.Stopping -> BadgeVariant.Warning
    BroadcastStatus.Live -> BadgeVariant.Success
}

private fun statusDescription(status: BroadcastStatus): String = when (status) {
    is BroadcastStatus.Idle -> "Tekan Mulai kerja, izinkan kamera & mikrofon, lalu pilih Bagikan seluruh layar. Layar HP, kamera depan, dan suara disiarkan ke atasan (mikrofon bisa dibisukan). Siaran tetap jalan saat Anda pindah aplikasi."
    is BroadcastStatus.Connecting -> status.message
    BroadcastStatus.Live -> "Sedang disiarkan. Anda boleh pindah aplikasi — siaran tetap jalan sampai Anda menekan Selesai kerja (di sini atau di notifikasi)."
    BroadcastStatus.Stopping -> "Menghentikan siaran..."
}
