'use strict'

/**
 * Login staf ke backend Lacak SMB (sama dengan dashboard web).
 *
 * Alur 2FA (wajib untuk akun biasa):
 *   POST {apiBase}/auth/login { username, password, client } ->
 *     - { access_token, user }             => langsung masuk (2FA dimatikan super_admin)
 *     - { requires_2fa, challenge_token }  => minta kode authenticator, lalu verify
 *     - { requires_2fa_setup }             => akun belum pasang 2FA (lakukan di dashboard web dulu)
 *   POST {apiBase}/auth/2fa/verify { challenge_token, code } -> { access_token, user }
 *
 * Memakai fetch bawaan Node (Electron) di main process, jadi kredensial & token
 * tidak pernah berada di renderer.
 */

async function postJson(url, payload) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => null)
    return { res, body }
}

async function login(config, username, password) {
    const { apiBase } = config.settings()
    try {
        const { res, body } = await postJson(`${apiBase}/auth/login`, { username, password, client: 'web_dashboard' })
        const data = body?.data
        if (res.ok && data?.access_token) return { ok: true, token: data.access_token, user: data.user }
        // Butuh kode authenticator: teruskan challenge_token untuk langkah verify.
        if (res.ok && data?.requires_2fa) return { ok: false, twoFactor: true, challengeToken: data.challenge_token }
        // Akun belum pernah menyiapkan 2FA: QR hanya di dashboard web, bukan di agen.
        if (res.ok && data?.requires_2fa_setup)
            return { ok: false, message: 'Akun ini belum menyiapkan 2FA. Siapkan dulu lewat dashboard web (login pertama), lalu masuk di sini.' }
        return { ok: false, message: body?.message || `Login gagal (HTTP ${res.status})` }
    } catch (err) {
        return { ok: false, message: `Tidak bisa menghubungi server: ${err.message}` }
    }
}

async function verifyTwoFactor(config, challengeToken, code) {
    const { apiBase } = config.settings()
    try {
        const { res, body } = await postJson(`${apiBase}/auth/2fa/verify`, { challenge_token: challengeToken, code })
        const data = body?.data
        if (res.ok && data?.access_token) return { ok: true, token: data.access_token, user: data.user }
        return { ok: false, message: body?.message || `Kode 2FA salah (HTTP ${res.status})` }
    } catch (err) {
        return { ok: false, message: `Tidak bisa menghubungi server: ${err.message}` }
    }
}

module.exports = { login, verifyTwoFactor }
