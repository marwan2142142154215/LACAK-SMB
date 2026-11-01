package com.lacaksmb.live.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.lacaksmb.live.BuildConfig
import com.lacaksmb.live.data.SessionStore
import com.lacaksmb.live.ui.components.AppButton
import com.lacaksmb.live.ui.components.AppButtonVariant
import com.lacaksmb.live.ui.theme.Accent500
import com.lacaksmb.live.ui.theme.Base400
import com.lacaksmb.live.ui.theme.Base50
import com.lacaksmb.live.ui.theme.LocalLacakPalette
import org.json.JSONObject

private val dashboardOrigin: Uri = Uri.parse(BuildConfig.DASHBOARD_URL.trimEnd('/'))

/** Kunci localStorage sesi dashboard (web-dashboard/src/stores/auth.js). */
private const val TOKEN_KEY = "lacak_master_token"
private const val USER_KEY = "lacak_master_user"

/** Ditambahkan ke user agent: dashboard menyembunyikan menu samping & siaran web (lib/embedded.js). */
private const val EMBED_UA_MARKER = "LacakLiveApp"

/**
 * Halaman dashboard web (chat, briefing, absensi, izin, pengumuman) di dalam APK: satu WebView
 * dipakai bersama semua tab, jadi pindah tab hanya pindah rute (tanpa memuat ulang aplikasi web).
 * Sesi login APK diteruskan ke localStorage dashboard -- staf tidak perlu login dua kali.
 */
class DashboardWeb(context: Context, private val sessionStore: SessionStore) {
    var progress by mutableStateOf(0)
        private set
    var failed by mutableStateOf(false)
        private set
    var canGoBack by mutableStateOf(false)
        private set

    /** Diisi layar: minta izin kamera/mikrofon (briefing) & pilih file (gambar chat). */
    var onPermissionRequest: ((PermissionRequest) -> Unit)? = null
    var onFileChooser: ((ValueCallback<Array<Uri>>, Boolean) -> Unit)? = null

    private var bootstrapped = false
    private var currentPath: String? = null
    private var darkTheme = true

    @SuppressLint("SetJavaScriptEnabled")
    val view: WebView = WebView(context).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.userAgentString = "${settings.userAgentString} $EMBED_UA_MARKER"
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.scheme == dashboardOrigin.scheme && url.authority == dashboardOrigin.authority) return false
                // Tautan ke luar (mis. lampiran) dibuka di browser HP.
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                failed = false
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                this@DashboardWeb.canGoBack = view.canGoBack()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) failed = true
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                this@DashboardWeb.progress = newProgress
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                onPermissionRequest?.invoke(request) ?: request.deny()
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                val chooser = onFileChooser ?: return false
                chooser(filePathCallback, fileChooserParams.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                return true
            }
        }
    }

    /** Buka rute dashboard (mis. "/chat"). Pertama kali: pasang sesi APK lalu muat dashboard. */
    fun open(path: String, darkTheme: Boolean) {
        this.darkTheme = darkTheme
        if (path == currentPath && !failed) return
        currentPath = path
        if (bootstrapped && !failed) {
            // Router dashboard pindah halaman tanpa memuat ulang (lihat window.__lacakGo di AppShell.vue).
            view.evaluateJavascript(
                "window.__lacakGo ? (window.__lacakGo(${JSONObject.quote(path)}), true) : false",
            ) { handled -> if (handled != "true") view.loadUrl(urlOf(path)) }
            return
        }
        bootstrapped = true
        val token = sessionStore.accessToken().orEmpty()
        val user = sessionStore.user()?.toJson()?.toString() ?: "null"
        // Halaman kecil berasal (origin) dashboard: mengisi localStorage-nya lalu pindah ke rute tujuan.
        val html = """
            <!doctype html><meta charset="utf-8"><script>
            try {
              localStorage.setItem(${JSONObject.quote(TOKEN_KEY)}, ${JSONObject.quote(token)});
              localStorage.setItem(${JSONObject.quote(USER_KEY)}, ${JSONObject.quote(user)});
              localStorage.setItem('lacak_theme', ${JSONObject.quote(if (darkTheme) "dark" else "light")});
            } catch (e) {}
            location.replace(${JSONObject.quote(urlOf(path))});
            </script>
        """.trimIndent()
        view.loadDataWithBaseURL("$dashboardOrigin/", html, "text/html", "utf-8", null)
    }

    fun retry() {
        failed = false
        bootstrapped = false
        currentPath?.let { path ->
            currentPath = null
            open(path, darkTheme)
        }
    }

    private fun urlOf(path: String) = "$dashboardOrigin$path"

    companion object {
        /** Logout APK: sesi dashboard di WebView ikut dihapus. */
        fun clearSession() {
            WebStorage.getInstance().deleteAllData()
            CookieManager.getInstance().removeAllCookies(null)
        }
    }
}

@Composable
fun DashboardWebPage(web: DashboardWeb, path: String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val darkTheme = LocalLacakPalette.current.isDark
    var pendingRequest by remember { mutableStateOf<PermissionRequest?>(null) }
    var fileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }

    // Briefing (video rapat): izin kamera & mikrofon Android dulu, baru izin halaman diberikan.
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val request = pendingRequest ?: return@rememberLauncherForActivityResult
        pendingRequest = null
        grantAllowed(context, request)
    }
    val fileLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        fileCallback?.onReceiveValue(uris.toTypedArray())
        fileCallback = null
    }

    DisposableEffect(web) {
        web.onPermissionRequest = { request ->
            val needed = androidPermissionsFor(request).filter {
                ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
            }
            if (needed.isEmpty()) {
                grantAllowed(context, request)
            } else {
                pendingRequest = request
                permissionLauncher.launch(needed.toTypedArray())
            }
        }
        web.onFileChooser = { callback, _ ->
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            fileLauncher.launch("image/*")
        }
        onDispose {
            web.onPermissionRequest = null
            web.onFileChooser = null
        }
    }

    LaunchedEffect(path) { web.open(path, darkTheme) }

    BackHandler(enabled = web.canGoBack) { web.view.goBack() }

    Box(modifier = modifier.fillMaxSize()) {
        AndroidView(
            factory = { (web.view.parent as? android.view.ViewGroup)?.removeView(web.view); web.view },
            modifier = Modifier.fillMaxSize(),
        )
        if (web.progress in 1..99) {
            LinearProgressIndicator(
                progress = { web.progress / 100f },
                modifier = Modifier.fillMaxWidth().align(Alignment.TopCenter),
                color = Accent500,
            )
        }
        if (web.failed) {
            Column(
                modifier = Modifier.fillMaxSize().padding(32.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("Halaman belum bisa dibuka", style = MaterialTheme.typography.titleMedium, color = Base50)
                Text(
                    "Periksa koneksi internet, lalu coba lagi.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Base400,
                    textAlign = TextAlign.Center,
                )
                AppButton(text = "Coba lagi", onClick = { web.retry() }, variant = AppButtonVariant.Outline)
            }
        }
    }
}

private fun androidPermissionsFor(request: PermissionRequest): List<String> = buildList {
    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE in request.resources) add(Manifest.permission.CAMERA)
    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources) add(Manifest.permission.RECORD_AUDIO)
}

/** Hanya sumber yang izin Androidnya sudah diberikan staf; sisanya ditolak (halaman tetap jalan). */
private fun grantAllowed(context: Context, request: PermissionRequest) {
    val allowed = request.resources.filter { resource ->
        when (resource) {
            PermissionRequest.RESOURCE_VIDEO_CAPTURE -> granted(context, Manifest.permission.CAMERA)
            PermissionRequest.RESOURCE_AUDIO_CAPTURE -> granted(context, Manifest.permission.RECORD_AUDIO)
            else -> false
        }
    }
    if (allowed.isEmpty()) request.deny() else request.grant(allowed.toTypedArray())
}

private fun granted(context: Context, permission: String) =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
