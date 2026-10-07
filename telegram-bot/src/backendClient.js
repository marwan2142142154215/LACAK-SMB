const axios = require('axios')

/**
 * Satu-satunya jalur bot bicara ke backend-api, memakai token akun layanan
 * telegram-bot (lihat backend-api IssueTelegramBotToken). Bot TIDAK pernah
 * login interaktif (akun ini is_active=false, tidak bisa lewat AuthController).
 */
const api = axios.create({
    baseURL: process.env.BACKEND_API_URL,
    headers: {
        Authorization: `Bearer ${process.env.BACKEND_API_TOKEN}`,
        Accept: 'application/json',
    },
    timeout: 10_000,
})

/**
 * Cocokkan chat_id Telegram ke organization_id lewat endpoint lookup
 * khusus (tidak butuh permission telegram.manage penuh).
 */
async function resolveOrganizationId(chatId) {
    try {
        const response = await api.get('/telegram-bindings-lookup', { params: { chat_id: String(chatId) } })
        return response.data.data.organization_id
    } catch (error) {
        if (error.response?.status === 404) return null
        throw error
    }
}

async function listDevices(organizationId) {
    const response = await api.get('/devices', { params: { organization_id: organizationId, per_page: 50 } })
    return response.data.data.items
}

async function getDevice(deviceId) {
    const response = await api.get(`/devices/${deviceId}`)
    return response.data.data
}

async function issueCommand(deviceId, commandType, reasonNote) {
    const response = await api.post(`/devices/${deviceId}/commands`, {
        command_type: commandType,
        issued_via: 'telegram_bot',
        reason_note: reasonNote ?? null,
    })
    return response.data
}

module.exports = {
    resolveOrganizationId,
    listDevices,
    getDevice,
    issueCommand,
}
