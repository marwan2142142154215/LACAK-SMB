'use strict'

/**
 * Login staf ke backend Lacak SMB (sama dengan dashboard web):
 * POST {apiBase}/auth/login { username, password, client: 'web_dashboard' }.
 * Memakai fetch bawaan Node (Electron >= 28) di main process, jadi kredensial
 * tidak pernah berada di renderer.
 */
async function login(config, username, password) {
    const { apiBase } = config.settings()
    try {
        const res = await fetch(`${apiBase}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ username, password, client: 'web_dashboard' }),
        })
        const body = await res.json().catch(() => null)
        if (!res.ok || !body?.data?.access_token) {
            return { ok: false, message: body?.message || `Login gagal (HTTP ${res.status})` }
        }
        return { ok: true, token: body.data.access_token, user: body.data.user }
    } catch (err) {
        return { ok: false, message: `Tidak bisa menghubungi server: ${err.message}` }
    }
}

module.exports = { login }
