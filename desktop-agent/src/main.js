'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, session, desktopCapturer } = require('electron')
const path = require('node:path')
const config = require('./config')
const { login, verifyTwoFactor } = require('./auth')
const { Reporter } = require('./reporter')
const { getWindowsLocation } = require('./winLocation')

const IS_WINDOWS = process.platform === 'win32'
const DASHBOARD_PARTITION = 'persist:lacak-dashboard'

// Satu instance saja: menjalankan lagi hanya memunculkan jendela yang ada.
if (!app.requestSingleInstanceLock()) {
    app.quit()
}

// Ikon tray: lingkaran radar amber 32x32 (data URL inline -- tidak perlu file aset terpisah
// saat dibundel). OS memperkecil otomatis ke ukuran tray.
const TRAY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAmElEQVR4nO3VuxKAIAxEUXp7K7/dv7TW3hHCbrIBHTNDKfeM+CjlbXPsy9laQ6JSDBt3I7xhF8TabFvL4wpBoFEUQwHQeAuRFocRijiEUMVriLkAzO2/j+sYvHEWQQGs+QHfB6Q8hOmv4fAP0ZSA9J+RCtEdVyDgeA3AIGr7mIAWwsJY13XFexHoguKREDocgQiJoxhJVDkXDNy+pFzgXL4AAAAASUVORK5CYII='

let tray = null
let loginWin = null
let gateWin = null
let geoWin = null
let statusWin = null
let dashboardWin = null
let dashboardSessionReady = false
let reporter = null

const state = {
    signedIn: false,
    locating: false,
    lastError: null,
    lastFixAt: null,
}

function trayIcon() {
    try {
        const img = nativeImage.createFromDataURL(TRAY_PNG)
        return img.isEmpty() ? nativeImage.createEmpty() : img
    } catch {
        return nativeImage.createEmpty()
    }
}

function statusLine() {
    const user = config.getUser()
    if (!state.signedIn) return 'Belum login'
    if (state.lastError) return `Lokasi bermasalah: ${state.lastError}`
    if (state.locating) return `Memantau lokasi — ${user?.name ?? ''}`.trim()
    return `Login sebagai ${user?.name ?? '-'} (menunggu lokasi)`
}

function updateTray() {
    if (!tray) return
    tray.setToolTip(`Lacak SMB Agent — ${statusLine()}`)
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: statusLine(), enabled: false },
            { type: 'separator' },
            ...(state.signedIn
                ? [
                      { label: 'Buka dashboard', click: () => showDashboard() },
                      { label: 'Buka status', click: () => showStatus() },
                  ]
                : []),
            ...(IS_WINDOWS
                ? [{ label: 'Buka Setelan Lokasi Windows', click: () => shell.openExternal('ms-settings:privacy-location').catch(() => {}) }]
                : []),
            { type: 'separator' },
            {
                label: state.signedIn ? 'Keluar (logout)' : 'Login…',
                click: () => (state.signedIn ? signOut() : showLogin()),
            },
            { label: 'Keluar aplikasi', click: () => app.quit() },
        ])
    )
    broadcastState()
}

function broadcastState() {
    for (const win of [loginWin, gateWin, statusWin]) {
        if (win && !win.isDestroyed()) win.webContents.send('state', { ...state, user: config.getUser() })
    }
}

function createTray() {
    if (tray) return
    tray = new Tray(trayIcon())
    tray.on('click', () => (state.signedIn ? showDashboard() : showLogin()))
    updateTray()
}

// --- Jendela ---------------------------------------------------------------
function baseWebPrefs() {
    return {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
    }
}

function showLogin() {
    if (loginWin && !loginWin.isDestroyed()) return loginWin.focus()
    loginWin = new BrowserWindow({
        width: 380,
        height: 460,
        resizable: false,
        title: 'Lacak SMB Agent — Masuk',
        webPreferences: baseWebPrefs(),
    })
    loginWin.loadFile(path.join(__dirname, 'windows', 'login.html'))
    loginWin.on('closed', () => (loginWin = null))
}

/** Hidden renderer yang menjalankan navigator.geolocation.watchPosition. */
function ensureGeoWindow() {
    if (geoWin && !geoWin.isDestroyed()) return
    geoWin = new BrowserWindow({ show: false, webPreferences: baseWebPrefs() })
    geoWin.loadFile(path.join(__dirname, 'windows', 'geo.html'))
    geoWin.on('closed', () => (geoWin = null))
}

/** Gate WAJIB lokasi: lokasi mati/ditolak -> jendela penghalang sampai lokasi aktif. */
function showGate(message) {
    if (!state.signedIn) return
    if (gateWin && !gateWin.isDestroyed()) {
        broadcastState()
        return gateWin.focus()
    }
    gateWin = new BrowserWindow({
        width: 420,
        height: 360,
        resizable: false,
        title: 'Lokasi diperlukan',
        webPreferences: baseWebPrefs(),
    })
    gateWin.loadFile(path.join(__dirname, 'windows', 'gate.html'))
    gateWin.on('closed', () => (gateWin = null))
    gateWin.webContents.once('did-finish-load', broadcastState)
    state.lastError = message ?? state.lastError
}

function closeGate() {
    if (gateWin && !gateWin.isDestroyed()) gateWin.close()
    gateWin = null
}

// Jendela status: supaya agen yang sudah login (hidup di tray, tanpa jendela) tetap bisa
// dibuka -- memperlihatkan status lokasi, lokasi terakhir, dan tombol logout.
function showStatus() {
    if (!state.signedIn) return showLogin()
    if (statusWin && !statusWin.isDestroyed()) return statusWin.focus()
    statusWin = new BrowserWindow({
        width: 380,
        height: 430,
        resizable: false,
        title: 'Lacak SMB Agent',
        webPreferences: baseWebPrefs(),
    })
    statusWin.loadFile(path.join(__dirname, 'windows', 'status.html'))
    statusWin.on('closed', () => (statusWin = null))
    statusWin.webContents.once('did-finish-load', broadcastState)
}

// Izin untuk sesi dashboard: Live Kerja butuh kamera, mikrofon, dan bagi layar. Electron
// menolak izin media secara bawaan, jadi kita izinkan untuk origin dashboard di sini.
function setupDashboardSession() {
    if (dashboardSessionReady) return
    dashboardSessionReady = true
    const ses = session.fromPartition(DASHBOARD_PARTITION)
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(['media', 'display-capture', 'notifications', 'geolocation', 'clipboard-sanitized-write'].includes(permission))
    })
    // getDisplayMedia (bagi layar Live Kerja): pilih layar utama otomatis, tanpa dialog pemilih.
    ses.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer
            .getSources({ types: ['screen'] })
            .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
            .catch(() => callback({}))
    })
}

// Dashboard web PENUH di dalam aplikasi, auto-login dari token agen (lihat dashboardPreload.js),
// sambil lokasi tetap terlacak di latar belakang. Pakai partition sendiri supaya logout bisa
// membersihkan sesinya (clearStorageData di signOut).
function showDashboard() {
    if (!state.signedIn) return showLogin()
    if (dashboardWin && !dashboardWin.isDestroyed()) return dashboardWin.focus()
    setupDashboardSession()
    const { dashboardUrl } = config.settings()
    const payload = encodeURIComponent(JSON.stringify({ token: config.getToken(), user: config.getUser() }))
    dashboardWin = new BrowserWindow({
        width: 1280,
        height: 820,
        title: 'Lacak SMB',
        webPreferences: {
            preload: path.join(__dirname, 'dashboardPreload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            partition: DASHBOARD_PARTITION,
            additionalArguments: [`--lacak-session=${payload}`],
        },
    })
    dashboardWin.loadURL(dashboardUrl)
    dashboardWin.on('closed', () => (dashboardWin = null))
}

// --- Lokasi Windows (WinRT di main process) --------------------------------
// navigator.geolocation (geo.html) butuh Google API key & tak andal di Windows,
// jadi di Windows lokasi diambil lewat WinRT. macOS tetap pakai geo.html (CoreLocation).
let geoTimer = null
let geoPolling = false

async function pollWindowsLocation() {
    if (geoPolling || !state.signedIn) return
    geoPolling = true
    try {
        const res = await getWindowsLocation()
        if (!state.signedIn) return
        if (res.ok) {
            state.locating = true
            state.lastError = null
            state.lastFixAt = Date.now()
            closeGate()
            reporter?.sendLocation({ latitude: res.latitude, longitude: res.longitude, accuracy: res.accuracy })
        } else {
            state.locating = false
            showGate(res.message || 'Lokasi tidak tersedia.')
        }
        updateTray()
    } finally {
        geoPolling = false
    }
}

function startWindowsGeo() {
    stopWindowsGeo()
    const { intervalMs } = config.settings()
    pollWindowsLocation()
    geoTimer = setInterval(pollWindowsLocation, Math.max(10_000, intervalMs))
}

function stopWindowsGeo() {
    if (geoTimer) clearInterval(geoTimer)
    geoTimer = null
}

// --- Alur utama ------------------------------------------------------------
function beginTracking() {
    state.signedIn = true
    state.lastError = null
    reporter = new Reporter(config)
    reporter.onExpired = () => signOut('Sesi berakhir, silakan login ulang.')
    reporter.connect()
    if (IS_WINDOWS) startWindowsGeo()
    else ensureGeoWindow()
    updateTray()
}

function signOut(reason) {
    config.clearSession()
    reporter?.disconnect()
    reporter = null
    stopWindowsGeo()
    if (geoWin && !geoWin.isDestroyed()) geoWin.close()
    geoWin = null
    if (statusWin && !statusWin.isDestroyed()) statusWin.close()
    statusWin = null
    if (dashboardWin && !dashboardWin.isDestroyed()) dashboardWin.close()
    dashboardWin = null
    session.fromPartition(DASHBOARD_PARTITION).clearStorageData().catch(() => {})
    closeGate()
    state.signedIn = false
    state.locating = false
    state.lastError = reason ?? null
    updateTray()
    showLogin()
}

function start() {
    // Buang menu bawaan Electron (File/Edit/View/Window/Help) -- app tray, tak perlu menu jendela.
    Menu.setApplicationMenu(null)
    // Autostart saat login Windows; '--hidden' supaya langsung ke tray.
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] })
    createTray()
    if (config.getToken()) {
        beginTracking()
        // Autostart (--hidden) tetap diam di tray; start manual langsung buka dashboard.
        if (!process.argv.includes('--hidden')) showDashboard()
    } else {
        showLogin()
    }
}

// --- IPC dari renderer ------------------------------------------------------
// Sukses login (langsung atau setelah verifikasi 2FA): simpan sesi, tutup jendela, mulai pantau.
function finishSignIn(res) {
    config.setSession(res.token, res.user)
    if (loginWin && !loginWin.isDestroyed()) loginWin.close()
    beginTracking()
    showDashboard()
}

ipcMain.handle('login', async (_event, creds) => {
    const res = await login(config, creds?.username ?? '', creds?.password ?? '')
    if (res.ok) finishSignIn(res)
    // twoFactor + challengeToken diteruskan ke renderer supaya bisa lanjut ke langkah kode 2FA.
    return { ok: res.ok, twoFactor: res.twoFactor ?? false, challengeToken: res.challengeToken ?? null, message: res.message ?? null }
})

ipcMain.handle('verify2fa', async (_event, payload) => {
    const res = await verifyTwoFactor(config, payload?.challengeToken ?? '', payload?.code ?? '')
    if (res.ok) finishSignIn(res)
    return { ok: res.ok, message: res.message ?? null }
})

ipcMain.on('geo:fix', (_event, fix) => {
    if (!state.signedIn || !fix) return
    state.locating = true
    state.lastError = null
    state.lastFixAt = Date.now()
    closeGate()
    reporter?.sendLocation(fix)
    updateTray()
})

ipcMain.on('geo:error', (_event, payload) => {
    if (!state.signedIn) return
    state.locating = false
    showGate(payload?.message ?? 'Lokasi tidak tersedia.')
    updateTray()
})

ipcMain.on('geo:retry', () => {
    // Windows: minta lokasi lagi lewat WinRT (geoWin tidak dipakai di Windows).
    if (IS_WINDOWS) {
        pollWindowsLocation()
        return
    }
    // macOS: muat ulang renderer geolokasi supaya izin diminta lagi.
    if (geoWin && !geoWin.isDestroyed()) geoWin.reload()
})

ipcMain.on('geo:open-settings', () => {
    // Buka langsung halaman Setelan Lokasi Windows -- staf tinggal geser satu tombol,
    // tanpa menavigasi menu. (Windows tidak mengizinkan aplikasi menyalakannya sendiri.)
    shell.openExternal('ms-settings:privacy-location').catch(() => {})
})

ipcMain.on('agent:logout', () => signOut('Anda keluar dari agen.'))

ipcMain.handle('state:get', () => ({ ...state, user: config.getUser() }))

// --- Lifecycle -------------------------------------------------------------
app.on('second-instance', () => {
    // Dijalankan lagi saat sudah hidup: tampilkan jendela yang relevan (bukan diam saja).
    if (!state.signedIn) {
        showLogin()
    } else if (gateWin && !gateWin.isDestroyed()) {
        gateWin.focus()
    } else {
        showDashboard()
    }
})

// Aplikasi tray: menutup semua jendela TIDAK mematikan aplikasi.
app.on('window-all-closed', (event) => event.preventDefault())

app.whenReady().then(start)
