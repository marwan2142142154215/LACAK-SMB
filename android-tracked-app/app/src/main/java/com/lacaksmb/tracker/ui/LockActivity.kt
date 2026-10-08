package com.lacaksmb.tracker.ui

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputFilter
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver
import com.lacaksmb.tracker.data.DeviceIdentityStore
import com.lacaksmb.tracker.data.DeviceLockStore
import com.lacaksmb.tracker.network.DeviceOtpApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Layar penuh WAJIB saat perangkat dikunci jarak jauh — INI SATU-SATUNYA
 * jalan keluar selain admin membuka dari dashboard/bot Telegram:
 *
 *  - Ditampilkan sebagai Activity tersendiri (bukan sekadar lapisan overlay)
 *    supaya bisa memakai startLockTask() (screen pinning resmi Android):
 *    selama dipin, tombol Home DAN Recents dinonaktifkan oleh SISTEM, bukan
 *    cuma ditutupi tampilan — menekan Home tidak melakukan apa-apa.
 *  - Tombol Back juga di-nonaktifkan total (onBackPressed di-override kosong).
 *  - Dikeluarkan dari daftar recents (FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
 *    supaya tidak ada cara swipe-away.
 *  - onUserLeaveHint() (dipanggil sistem saat ada upaya pindah ke app lain,
 *    termasuk gesture Home di Android modern) langsung memasang ulang lock
 *    task — menjaga walau startLockTask() di suatu OEM sempat terlewati.
 *  - Polling DeviceLockStore tiap 2 detik: begitu admin unlock dari
 *    dashboard/bot Telegram, layar ini otomatis menutup sendiri.
 *  - OTP diverifikasi ke backend-api lewat endpoint publik
 *    /device-otp/verify (device terkunci tidak bisa login).
 *
 * CATATAN: startLockTask() pada app yang bukan Device Owner tetap bisa
 * dipin (ini "standard/non-owner" lock task — didukung sejak API 23),
 * sistem hanya menampilkan dialog konfirmasi pin SEKALI di awal. Setelah
 * terpin, Home & Recents nonaktif sampai stopLockTask() dipanggil (hanya
 * dipanggil kode ini sendiri setelah OTP benar atau admin unlock).
 */
class LockActivity : ComponentActivity() {

    private lateinit var identityStore: DeviceIdentityStore
    private lateinit var lockStore: DeviceLockStore
    private var watchdogJob: Job? = null
    private var currentReason: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        identityStore = DeviceIdentityStore(applicationContext)
        lockStore = DeviceLockStore(applicationContext)
        currentReason = intent?.getStringExtra(EXTRA_REASON).orEmpty()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
            )
        }
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)

        setContentView(buildLockView(currentReason))
        requestLockTask()
        applyImmersiveMode()
        startUnlockWatchdog()
    }

    override fun onResume() {
        super.onResume()
        requestLockTask()
        applyImmersiveMode()
    }

    /** System bar (Back/Home/Recents + status bar) disembunyikan lagi setiap
     *  kali activity kembali fokus, termasuk setelah user sempat menggeser
     *  untuk memunculkannya sekejap — supaya tombol navigasi tidak bisa
     *  dipakai sama sekali. */
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersiveMode()
    }

    /** Menahan tombol fisik/keras: Back, Recents (App Switch), Home, Menu,
     *  Search. Home/Recents sendiri sudah dinonaktifkan SISTEM oleh
     *  startLockTask(); ini lapisan tambahan untuk perangkat yang tetap
     *  mengirimkan event tombol ke activity. */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        return when (keyCode) {
            KeyEvent.KEYCODE_BACK,
            KeyEvent.KEYCODE_APP_SWITCH,
            KeyEvent.KEYCODE_HOME,
            KeyEvent.KEYCODE_MENU,
            KeyEvent.KEYCODE_SEARCH,
            -> true
            else -> super.onKeyDown(keyCode, event)
        }
    }

    /** Dipanggil sistem saat ada upaya keluar (gesture Home/Recents dll). */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        lifecycleScope.launch {
            if (lockStore.snapshot().adminLocked) {
                requestLockTask()
            }
        }
    }

    @Deprecated("Deprecated in Java, tetap dipakai untuk menonaktifkan tombol back")
    override fun onBackPressed() {
        // Sengaja kosong — tombol back tidak melakukan apa-apa selama locked.
    }

    private fun requestLockTask() {
        try {
            // Kalau jadi Device Owner: pakai lock-task penuh (gesture unpin
            // dimatikan sistem). Kalau bukan: startLockTask() = screen pinning
            // biasa; tombol navigasi sudah disembunyikan lewat immersive mode.
            TrackerDeviceAdminReceiver.enableFullLockTaskIfDeviceOwner(this)
            startLockTask()
        } catch (_: Exception) {
            // Sebagian OEM membatasi screen pinning untuk app non-Device-Owner.
            // lockNow() dari Device Admin (dipanggil service) tetap jadi
            // jaring pengaman minimum kalau pinning gagal di perangkat itu.
        }
    }

    /** Menyembunyikan status bar dan tombol navigasi (Back/Home/Recents)
     *  secara "immersive sticky": bars hilang permanen, dan kalau user
     *  menggeser dari tepi layar, bars hanya muncul sekejap lalu tersembunyi
     *  lagi otomatis. Inilah yang membuat mode lock tidak bisa di-bypass lewat
     *  kombinasi tombol navigasi. */
    private fun applyImmersiveMode() {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let { controller ->
                controller.hide(
                    WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars(),
                )
                controller.systemBarsBehavior =
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        }
    }

    /** Memeriksa status kunci tiap 2 detik — admin unlock dari dashboard/bot Telegram menutup layar ini otomatis. */
    private fun startUnlockWatchdog() {
        watchdogJob?.cancel()
        watchdogJob = lifecycleScope.launch {
            while (true) {
                delay(2_000L)
                // Pasang ulang immersive tiap siklus: sebagian OEM menampilkan
                // kembali system bar setelah beberapa detik / setelah ada
                // interaksi; ini memaksa tombol navigasi tetap tersembunyi.
                applyImmersiveMode()
                if (!lockStore.snapshot().adminLocked) {
                    finishUnlocked(clearStore = false)
                    break
                }
            }
        }
    }

    private fun finishUnlocked(clearStore: Boolean) {
        watchdogJob?.cancel()
        if (clearStore) {
            lifecycleScope.launch { lockStore.clear() }
        }
        try {
            stopLockTask()
        } catch (_: Exception) {
            // Tidak sedang dipin — aman diabaikan.
        }
        finish()
    }

    override fun onDestroy() {
        watchdogJob?.cancel()
        super.onDestroy()
    }

    private fun buildLockView(reason: String): View {
        val density = resources.displayMetrics.density
        val dp = { value: Int -> (value * density).toInt() }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.BLACK)
            setPadding(dp(32), dp(24), dp(32), dp(24))
        }

        fun textView(text: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
            this.text = text
            this.textSize = size
            if (bold) typeface = Typeface.DEFAULT_BOLD
            setTextColor(color)
            gravity = Gravity.CENTER
        }

        fun margins(top: Int) = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(top) }

        val lockTitle = textView("SEGERA KEMBALI KE TEMPAT ANDA, BOSKU", 22f, Color.WHITE, bold = true)
        val lockReasonView = reason.takeIf { it.isNotBlank() }?.let {
            textView("Alasan: $it", 14f, 0xFFEF5350.toInt(), bold = true)
        }
        val lockSub = textView(
            "Perangkat ini dikunci jarak jauh oleh Lacak SMB karena\n" +
                "berada di luar jangkauan yang diizinkan. Kembali ke lokasi\n" +
                "Anda, atau masukkan kode OTP di bawah untuk membuka sendiri.",
            14f,
            Color.LTGRAY,
        )

        val otpInput = EditText(this).apply {
            hint = "Kode OTP 6 digit"
            inputType = InputType.TYPE_CLASS_NUMBER
            textSize = 20f
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            filters = arrayOf(InputFilter.LengthFilter(6))
        }

        val statusText = textView("", 13f, 0xFFF0B94A.toInt())

        val unlockButton = Button(this).apply {
            text = "Buka dengan OTP"
            isEnabled = true
        }

        unlockButton.setOnClickListener {
            val code = otpInput.text?.toString().orEmpty()
            if (code.length != 6) {
                statusText.setTextColor(0xFFEF5350.toInt())
                statusText.text = "Kode OTP harus 6 digit"
                return@setOnClickListener
            }
            unlockButton.isEnabled = false
            statusText.setTextColor(0xFFF0B94A.toInt())
            statusText.text = "Memeriksa kode..."
            lifecycleScope.launch {
                val uuid = identityStore.snapshot().deviceUuid
                val result = DeviceOtpApi.verify(uuid, code)
                if (result.isSuccess) {
                    finishUnlocked(clearStore = true)
                } else {
                    unlockButton.isEnabled = true
                    statusText.setTextColor(0xFFEF5350.toInt())
                    statusText.text = result.exceptionOrNull()?.message
                        ?: "Kode salah atau sudah kedaluwarsa, coba lagi"
                    otpInput.text?.clear()
                }
            }
        }

        root.addView(lockTitle)
        lockReasonView?.let { root.addView(it, margins(12)) }
        root.addView(lockSub, margins(20))
        root.addView(
            otpInput,
            LinearLayout.LayoutParams(dp(220), LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(28) },
        )
        root.addView(unlockButton, margins(16))
        root.addView(statusText, margins(12))
        return root
    }

    companion object {
        private const val EXTRA_REASON = "reason"

        /** Dipanggil dari service/receiver manapun — selalu task baru, selalu di luar recents. */
        fun launch(context: Context, reason: String?) {
            val intent = Intent(context, LockActivity::class.java).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP or
                        Intent.FLAG_ACTIVITY_NO_ANIMATION,
                )
                putExtra(EXTRA_REASON, reason)
            }
            context.startActivity(intent)
        }
    }
}
