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
import androidx.annotation.StringRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.automirrored.filled.StopScreenShare
import androidx.compose.material.icons.filled.FreeBreakfast
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.lacaksmb.live.R
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
import com.lacaksmb.live.ui.theme.Accent500
import com.lacaksmb.live.ui.theme.Base300
import com.lacaksmb.live.ui.theme.Base400
import com.lacaksmb.live.ui.theme.Base50
import com.lacaksmb.live.ui.theme.Base800
import com.lacaksmb.live.ui.theme.Base850
import com.lacaksmb.live.ui.theme.Danger400
import com.lacaksmb.live.ui.theme.Danger500
import com.lacaksmb.live.ui.theme.OnColor
import com.lacaksmb.live.ui.theme.StBreak
import com.lacaksmb.live.ui.theme.StWorking
import com.lacaksmb.live.ui.theme.Warning400
import com.lacaksmb.live.ui.theme.Warning500
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
    var user by remember { mutableStateOf(sessionStore.user()) }
    // Aturan peran bisa diubah admin kapan saja: muat profil terbaru setiap layar Live dibuka.
    LaunchedEffect(Unit) {
        apiClient.me()?.let { fresh ->
            sessionStore.saveUser(fresh)
            user = fresh
        }
    }
    // Peran "kamera saja" (izin live.screen-optional): layar tetap ditawarkan, tapi boleh ditolak/ditutup
    // tanpa peringatan Screen off -- sama dengan dashboard web.
    val screenOptional = user?.screenOptional == true
    val status by LiveBroadcastState.status.collectAsStateWithLifecycle()
    val room by LiveBroadcastState.room.collectAsStateWithLifecycle()
    val liveSince by LiveBroadcastState.liveSince.collectAsStateWithLifecycle()
    val micState by LiveBroadcastState.micState.collectAsStateWithLifecycle()
    val screenSharing by LiveBroadcastState.screenSharing.collectAsStateWithLifecycle()
    val cameraActive by LiveBroadcastState.cameraActive.collectAsStateWithLifecycle()
    val faceMissing by LiveBroadcastState.faceMissing.collectAsStateWithLifecycle()
    val onBreak by LiveBroadcastState.onBreak.collectAsStateWithLifecycle()
    var permissionError by remember { mutableStateOf<String?>(null) }
    val snackbar = remember { SnackbarHostState() }

    val canBroadcast = user?.can("live.broadcast") == true
    val busy = status is BroadcastStatus.Connecting || status is BroadcastStatus.Stopping
    val active = status !is BroadcastStatus.Idle
    val live = status is BroadcastStatus.Live

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
        // Peran kamera saja boleh melewati berbagi layar: bukan kesalahan.
        if (data == null && !screenOptional) {
            permissionError = context.getString(R.string.live_screen_share_denied)
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
            permissionError = context.getString(R.string.live_camera_permission)
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

    // Sama dengan toggleBreak di web-dashboard LiveView.vue (teks toast-nya juga).
    fun toggleBreak() {
        val next = !onBreak
        LiveBroadcastService.setBreak(context.applicationContext, next)
        val message = if (next) {
            context.getString(R.string.live_break_started) + " — " + context.getString(R.string.live_break_started_detail)
        } else {
            context.getString(R.string.live_break_ended)
        }
        scope.launch {
            snackbar.currentSnackbarData?.dismiss()
            snackbar.showSnackbar(message)
        }
    }

    Scaffold(
        topBar = {
            AppTopBar(
                title = stringResource(R.string.live_title),
                actions = {
                    IconButton(
                        enabled = !active,
                        onClick = {
                            scope.launch { apiClient.logout() }
                            sessionStore.clear()
                            DashboardWeb.clearSession()
                            navController.navigate(Routes.LOGIN) { popUpTo(0) }
                        },
                    ) { Icon(Icons.AutoMirrored.Filled.Logout, stringResource(R.string.live_logout), tint = Base300) }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val badge = statusBadge(status, onBreak, screenSharing || screenOptional, cameraActive)
            SectionCard(contentPadding = PaddingValues(16.dp)) {
                // Kepala: siapa yang menyiarkan + status siaran.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val name = user?.name ?: stringResource(R.string.live_staff_fallback)
                    Box(
                        modifier = Modifier.size(40.dp).background(Accent500.copy(alpha = 0.14f), CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            name.trim().take(1).uppercase(),
                            color = Accent500,
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    Column(modifier = Modifier.weight(1f).padding(horizontal = 12.dp)) {
                        Text(
                            name,
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = Base50,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            stringResource(if (screenOptional) R.string.live_subtitle_camera else R.string.live_subtitle),
                            style = MaterialTheme.typography.bodySmall,
                            color = Base400,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    StatusBadge(stringResource(badge.label), badge.variant, dot = live)
                }

                // Pratinjau kamera sendiri + durasi siaran di pojok.
                Box(
                    modifier = Modifier
                        .padding(top = 16.dp)
                        .fillMaxWidth()
                        .aspectRatio(3f / 4f)
                        .clip(RoundedCornerShape(12.dp))
                        .background(Base850),
                    contentAlignment = Alignment.Center,
                ) {
                    val currentRoom = room
                    if (currentRoom != null && live) {
                        LocalCameraPreview(currentRoom)
                    } else {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(
                                if (active) Icons.Filled.Videocam else Icons.Filled.VideocamOff,
                                contentDescription = null,
                                tint = Base400,
                                modifier = Modifier.size(32.dp),
                            )
                            Text(
                                stringResource(if (active) R.string.live_preview_connecting else R.string.live_preview_off),
                                style = MaterialTheme.typography.bodySmall,
                                color = Base400,
                                modifier = Modifier.padding(top = 8.dp),
                            )
                        }
                    }
                    liveSince?.let { since ->
                        LiveDuration(
                            since = since,
                            onBreak = onBreak,
                            modifier = Modifier.align(Alignment.TopStart).padding(10.dp),
                        )
                    }
                }

                // Kondisi siaran sekilas: layar, kamera, mikrofon.
                if (live) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                    ) {
                        Indicator(
                            icon = if (screenSharing) Icons.AutoMirrored.Filled.ScreenShare else Icons.AutoMirrored.Filled.StopScreenShare,
                            label = stringResource(R.string.live_ind_screen),
                            value = stringResource(if (screenSharing) R.string.live_ind_shared else R.string.live_ind_off),
                            ok = screenSharing,
                            modifier = Modifier.weight(1f),
                        )
                        Indicator(
                            icon = if (cameraActive) Icons.Filled.Videocam else Icons.Filled.VideocamOff,
                            label = stringResource(R.string.live_ind_camera),
                            value = stringResource(if (cameraActive) R.string.live_ind_on else R.string.live_ind_off),
                            ok = cameraActive,
                            modifier = Modifier.weight(1f),
                        )
                        Indicator(
                            icon = if (micState == MicState.On) Icons.Filled.Mic else Icons.Filled.MicOff,
                            label = stringResource(R.string.live_ind_mic),
                            value = stringResource(
                                when (micState) {
                                    MicState.On -> R.string.live_ind_on
                                    MicState.Muted -> R.string.live_ind_muted
                                    MicState.None -> R.string.live_ind_none
                                },
                            ),
                            // Mikrofon dibisukan itu pilihan staf, bukan masalah.
                            ok = micState != MicState.None,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }

                // Pemberitahuan penting, satu per kotak.
                if (live && onBreak) {
                    Notice(
                        icon = Icons.Filled.FreeBreakfast,
                        color = StBreak,
                        title = stringResource(R.string.live_break_banner_title),
                        body = stringResource(R.string.live_break_banner_body),
                    )
                }
                if (live && !screenSharing && !screenOptional) {
                    Notice(
                        icon = Icons.AutoMirrored.Filled.StopScreenShare,
                        color = Warning500,
                        title = stringResource(R.string.live_screen_off_title),
                        body = stringResource(R.string.live_screen_off_body),
                    ) {
                        AppButton(
                            text = stringResource(R.string.live_screen_share),
                            icon = Icons.AutoMirrored.Filled.ScreenShare,
                            onClick = {
                                permissionError = null
                                requestScreenShare()
                            },
                            modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
                        )
                    }
                }
                if (live && faceMissing) {
                    Notice(icon = Icons.Filled.WarningAmber, color = Danger500, body = stringResource(R.string.live_face_missing))
                }
                val error = permissionError ?: (status as? BroadcastStatus.Idle)?.lastError
                error?.let { Notice(icon = Icons.Filled.WarningAmber, color = Danger500, body = it) }
                if (!canBroadcast) {
                    Notice(icon = Icons.Filled.WarningAmber, color = Warning500, body = stringResource(R.string.live_no_permission))
                }

                // Tombol utama. Saat siaran: Istirahat & mikrofon berdampingan,
                // Selesai kerja sendiri di bawah (aksi berbahaya, jangan tertekan tak sengaja).
                if (live) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
                    ) {
                        AppButton(
                            text = stringResource(if (onBreak) R.string.live_break_end else R.string.live_break_start),
                            icon = if (onBreak) Icons.Filled.PlayArrow else Icons.Filled.FreeBreakfast,
                            variant = if (onBreak) AppButtonVariant.Primary else AppButtonVariant.Outline,
                            onClick = { toggleBreak() },
                            modifier = Modifier.weight(1f),
                        )
                        MicButton(micState, modifier = Modifier.weight(1f))
                    }
                }
                if (active) {
                    AppButton(
                        text = stringResource(if (status is BroadcastStatus.Stopping) R.string.live_ending else R.string.live_end),
                        variant = AppButtonVariant.Danger,
                        loading = status is BroadcastStatus.Stopping,
                        enabled = status !is BroadcastStatus.Stopping,
                        onClick = { LiveBroadcastService.stop(context.applicationContext) },
                        modifier = Modifier.fillMaxWidth().padding(top = if (live) 8.dp else 16.dp),
                    )
                } else {
                    AppButton(
                        text = stringResource(R.string.live_start),
                        icon = Icons.Filled.Videocam,
                        enabled = canBroadcast && !busy,
                        onClick = { startWork() },
                        modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
                    )
                }

                Text(
                    (status as? BroadcastStatus.Connecting)?.message ?: stringResource(statusDescription(status)),
                    style = MaterialTheme.typography.bodySmall,
                    color = Base400,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }

            if (canBroadcast && status !is BroadcastStatus.Stopping) {
                SectionCard(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp)) {
                    BackgroundControl(live = active)
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

/** Satu kotak kondisi siaran (Layar / Kamera / Mikrofon): hijau = jalan, oranye = perlu perhatian. */
@Composable
private fun Indicator(icon: ImageVector, label: String, value: String, ok: Boolean, modifier: Modifier = Modifier) {
    val tint = if (ok) StWorking else Warning400
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(10.dp))
            .background(Base850)
            .border(1.dp, Base800, RoundedCornerShape(10.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
            Text(
                label,
                style = MaterialTheme.typography.labelSmall,
                color = Base400,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 6.dp),
            )
        }
        Text(
            value,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = tint,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 2.dp),
        )
    }
}

/** Kotak pemberitahuan berwarna lembut (istirahat, layar mati, galat). */
@Composable
private fun Notice(
    icon: ImageVector,
    color: Color,
    body: String,
    title: String? = null,
    action: (@Composable () -> Unit)? = null,
) {
    val shape = RoundedCornerShape(10.dp)
    Column(
        modifier = Modifier
            .padding(top = 12.dp)
            .fillMaxWidth()
            .clip(shape)
            .background(color.copy(alpha = 0.10f))
            .border(BorderStroke(1.dp, color.copy(alpha = 0.30f)), shape)
            .padding(12.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(18.dp))
            Column(modifier = Modifier.padding(start = 10.dp)) {
                if (title != null) {
                    Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = Base50)
                }
                Text(
                    body,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (title != null) Base300 else color,
                    modifier = Modifier.padding(top = if (title != null) 2.dp else 0.dp),
                )
            }
        }
        action?.invoke()
    }
}

/** Bisukan / nyalakan mikrofon. Tanpa izin mikrofon: arahkan ke pengaturan aplikasi. */
@Composable
private fun MicButton(state: MicState, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    when (state) {
        MicState.None -> AppButton(
            text = stringResource(R.string.live_mic_settings),
            icon = Icons.Filled.MicOff,
            variant = AppButtonVariant.Outline,
            onClick = {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
                runCatching { context.startActivity(intent) }
            },
            modifier = modifier,
        )
        else -> AppButton(
            text = stringResource(if (state == MicState.On) R.string.live_mic_mute else R.string.live_mic_unmute),
            icon = if (state == MicState.On) Icons.Filled.MicOff else Icons.Filled.Mic,
            variant = AppButtonVariant.Outline,
            onClick = { LiveBroadcastService.setMicMuted(context.applicationContext, state == MicState.On) },
            modifier = modifier,
        )
    }
}

/** Durasi siaran di pojok pratinjau; biru saat istirahat, merah saat siaran. */
@Composable
private fun LiveDuration(since: Long, onBreak: Boolean, modifier: Modifier = Modifier) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(since) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val total = ((now - since) / 1000).coerceAtLeast(0)
    val label = stringResource(if (onBreak) R.string.live_status_break else R.string.live_status_live)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .background(Color.Black.copy(alpha = 0.55f), CircleShape)
            .padding(horizontal = 10.dp, vertical = 5.dp),
    ) {
        Box(Modifier.size(7.dp).background(if (onBreak) StBreak else Danger400, CircleShape))
        Text(
            "$label  %02d:%02d:%02d".format(total / 3600, (total % 3600) / 60, total % 60),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = OnColor,
            modifier = Modifier.padding(start = 6.dp),
        )
    }
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

    SectionCard(title = stringResource(R.string.live_battery_title), contentPadding = PaddingValues(16.dp)) {
        Text(
            stringResource(R.string.live_battery_body),
            style = MaterialTheme.typography.bodySmall,
            color = Base400,
        )
        AppButton(
            text = stringResource(R.string.live_battery_open),
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

private data class Badge(@StringRes val label: Int, val variant: BadgeVariant)

/** Status di kepala kartu, urutan prioritas sama dengan statusOf di backend-adonis WorkPresence (break > camera_off > screen_off). */
private fun statusBadge(status: BroadcastStatus, onBreak: Boolean, screenSharing: Boolean, cameraActive: Boolean): Badge = when (status) {
    is BroadcastStatus.Idle -> Badge(R.string.live_status_idle, BadgeVariant.Neutral)
    is BroadcastStatus.Connecting -> Badge(R.string.live_status_connecting, BadgeVariant.Warning)
    BroadcastStatus.Stopping -> Badge(R.string.live_status_stopping, BadgeVariant.Warning)
    BroadcastStatus.Live -> when {
        onBreak -> Badge(R.string.live_status_break, BadgeVariant.Info)
        !cameraActive -> Badge(R.string.live_status_camera_off, BadgeVariant.Warning)
        !screenSharing -> Badge(R.string.live_status_screen_off, BadgeVariant.Warning)
        else -> Badge(R.string.live_status_live, BadgeVariant.Success)
    }
}

@StringRes
private fun statusDescription(status: BroadcastStatus): Int = when (status) {
    is BroadcastStatus.Idle -> R.string.live_desc_idle
    is BroadcastStatus.Connecting -> R.string.live_preview_connecting
    BroadcastStatus.Live -> R.string.live_desc_live
    BroadcastStatus.Stopping -> R.string.live_desc_stopping
}
