'use strict'

const { app, safeStorage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

/**
 * Konfigurasi & penyimpanan sesi agen desktop.
 *
 * - URL server: default ke produksi (lacaklive.smbservice.xyz). Bisa ditimpa per-PC
 *   lewat env (AGENT_API_BASE / AGENT_GATEWAY_URL) atau config.json di folder data
 *   aplikasi -- mis. untuk dev lokal. Lihat README.
 * - Token login: disimpan terenkripsi lewat safeStorage (DPAPI di Windows) kalau
 *   tersedia; kalau tidak, disimpan apa adanya dengan peringatan.
 */

const DEFAULTS = {
    apiBase: 'https://lacaklive.smbservice.xyz/api/v1',
    gatewayUrl: 'https://lacaklive.smbservice.xyz',
    // Jeda minimum kirim lokasi (server juga membatasi ~15 dtk).
    intervalMs: 25_000,
}

function dataDir() {
    return app.getPath('userData')
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        return null
    }
}

function fileConfig() {
    return readJson(path.join(dataDir(), 'config.json')) ?? {}
}

function settings() {
    const file = fileConfig()
    return {
        apiBase: process.env.AGENT_API_BASE || file.apiBase || DEFAULTS.apiBase,
        gatewayUrl: process.env.AGENT_GATEWAY_URL || file.gatewayUrl || DEFAULTS.gatewayUrl,
        intervalMs: Number(process.env.AGENT_INTERVAL_MS || file.intervalMs || DEFAULTS.intervalMs),
    }
}

// --- Sesi (token + user) ---------------------------------------------------
let session = undefined

function sessionFile() {
    return path.join(dataDir(), 'session.json')
}

function loadSession() {
    if (session !== undefined) return session
    const raw = readJson(sessionFile())
    if (!raw || !raw.token) {
        session = { token: null, user: null }
        return session
    }
    let token = raw.token
    try {
        if (raw.enc && safeStorage.isEncryptionAvailable()) {
            token = safeStorage.decryptString(Buffer.from(raw.token, 'base64'))
        }
    } catch {
        token = null
    }
    session = { token, user: raw.user ?? null }
    return session
}

function setSession(token, user) {
    session = { token, user }
    let stored = token
    let enc = false
    try {
        if (safeStorage.isEncryptionAvailable()) {
            stored = safeStorage.encryptString(token).toString('base64')
            enc = true
        }
    } catch {
        // Simpan apa adanya kalau enkripsi tak tersedia (dicatat di log oleh pemanggil).
    }
    fs.mkdirSync(dataDir(), { recursive: true })
    fs.writeFileSync(sessionFile(), JSON.stringify({ token: stored, enc, user }), 'utf8')
}

function clearSession() {
    session = { token: null, user: null }
    try {
        fs.rmSync(sessionFile(), { force: true })
    } catch {
        // tidak apa-apa
    }
}

module.exports = {
    settings,
    getToken: () => loadSession().token,
    getUser: () => loadSession().user,
    setSession,
    clearSession,
}
