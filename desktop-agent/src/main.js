'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron')
const path = require('node:path')
const config = require('./config')
const { login } = require('./auth')
const { Reporter } = require('./reporter')

// Satu instance saja: menjalankan lagi hanya memunculkan jendela yang ada.
if (!app.requestSingleInstanceLock()) {
    app.quit()
}

// Ikon tray placeholder (1x1 transparan) -- ganti dengan assets/tray.png saat rilis (lihat README).
const TRAY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

let tray = null
let loginWin = null
let gateWin = null
let geoWin = null
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
    for (const win of [loginWin, gateWin]) {
        if (win && !win.isDestroyed()) win.webContents.send('state', { ...state, user: config.getUser() })
    }
}

function createTray() {
    if (tray) return
    tray = new Tray(trayIcon())
    tray.on('click', () => (state.signedIn ? null : showLogin()))
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

// --- Alur utama ------------------------------------------------------------
function beginTracking() {
    state.signedIn = true
    state.lastError = null
    reporter = new Reporter(config)
    reporter.onExpired = () => signOut('Sesi berakhir, silakan login ulang.')
    reporter.connect()
    ensureGeoWindow()
    updateTray()
}

function signOut(reason) {
    config.clearSession()
    reporter?.disconnect()
    reporter = null
    if (geoWin && !geoWin.isDestroyed()) geoWin.close()
    geoWin = null
    closeGate()
    state.signedIn = false
    state.locating = false
    state.lastError = reason ?? null
    updateTray()
    showLogin()
}

function start() {
    // Autostart saat login Windows; '--hidden' supaya langsung ke tray.
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] })
    createTray()
    if (config.getToken()) beginTracking()
    else showLogin()
}

// --- IPC dari renderer ------------------------------------------------------
ipcMain.handle('login', async (_event, creds) => {
    const res = await login(config, creds?.username ?? '', creds?.password ?? '')
    if (res.ok) {
        config.setSession(res.token, res.user)
        if (loginWin && !loginWin.isDestroyed()) loginWin.close()
        beginTracking()
    }
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
    // Muat ulang renderer geolokasi supaya izin diminta lagi.
    if (geoWin && !geoWin.isDestroyed()) geoWin.reload()
})

ipcMain.handle('state:get', () => ({ ...state, user: config.getUser() }))

// --- Lifecycle -------------------------------------------------------------
app.on('second-instance', () => {
    if (state.signedIn) {
        if (gateWin && !gateWin.isDestroyed()) gateWin.focus()
    } else {
        showLogin()
    }
})

// Aplikasi tray: menutup semua jendela TIDAK mematikan aplikasi.
app.on('window-all-closed', (event) => event.preventDefault())

app.whenReady().then(start)
