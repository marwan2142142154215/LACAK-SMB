import axios, { type AxiosRequestConfig } from 'axios'
import env from '#start/env'

export type DeviceLocation = {
    source: string
    ble_distance_meters: number | null
    recorded_at: string
}

export type Device = {
    id: number
    organization_id: number
    device_name: string
    status: string
    battery_level: number | null
    latest_location?: DeviceLocation | null
}

export type ApkBuild = {
    id: number
    status: string
    version: string
    embedded_site_code: string
    download_url: string
    build_log: string | null
}

/**
 * Satu-satunya jalur bot bicara ke backend-api, memakai token akun layanan
 * telegram-bot (lihat backend-api IssueTelegramBotToken). Bot TIDAK pernah
 * login interaktif (akun ini is_active=false, tidak bisa lewat AuthController).
 */
const api = axios.create({
    baseURL: env.get('BACKEND_API_URL'),
    headers: {
        Authorization: `Bearer ${env.get('BACKEND_API_TOKEN').release()}`,
        Accept: 'application/json',
    },
    timeout: 10_000,
})

/**
 * Semua panggilan atas nama sebuah chat WAJIB menyertakan chat_id-nya:
 * backend-api me-resolve site dari header ini (ResolvesOrganizationScope)
 * dan menolak device/build milik site lain.
 */
function asChat(chatId: number, params?: Record<string, unknown>): AxiosRequestConfig {
    return { headers: { 'X-Telegram-Chat-Id': String(chatId) }, params }
}

/**
 * Cocokkan chat_id Telegram ke organization_id lewat endpoint lookup
 * khusus (tidak butuh permission telegram.manage penuh).
 */
export async function resolveOrganizationId(chatId: number): Promise<number | null> {
    try {
        const response = await api.get('/telegram-bindings-lookup', {
            params: { chat_id: String(chatId) },
        })
        return response.data.data.organization_id
    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) return null
        throw error
    }
}

/** Akun staf yang ditautkan ke akun Telegram pengirim pesan. */
export type StaffLink = {
    id: number
    name: string
    username: string
    organization_id: number | null
    roles: string[]
    permissions: string[]
    accessible_organization_ids: number[]
}

/**
 * Cocokkan akun Telegram pengirim (ctx.from.id) ke akun staf lewat endpoint
 * lookup khusus akun layanan bot. null = belum ditautkan atau staf nonaktif.
 */
export async function resolveUserLink(telegramUserId: number): Promise<StaffLink | null> {
    try {
        const response = await api.get('/telegram-user-links-lookup', {
            params: { telegram_user_id: String(telegramUserId) },
        })
        return response.data.data
    } catch (error) {
        const status = responseStatusOf(error)
        if (status === 403 || status === 404) return null
        throw error
    }
}

export async function listDevices(chatId: number, organizationId: number): Promise<Device[]> {
    const response = await api.get(
        '/devices',
        asChat(chatId, { organization_id: organizationId, per_page: 50 })
    )
    return response.data.data.items
}

export async function getDevice(chatId: number, deviceId: string): Promise<Device> {
    const response = await api.get(`/devices/${encodeURIComponent(deviceId)}`, asChat(chatId))
    return response.data.data
}

export async function issueCommand(
    chatId: number,
    deviceId: string,
    commandType: string,
    reasonNote: string | null
) {
    const response = await api.post(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        {
            command_type: commandType,
            issued_via: 'telegram_bot',
            reason_note: reasonNote ?? null,
        },
        asChat(chatId)
    )
    return response.data
}

/** Memicu build APK sungguhan (tracker/master) untuk site chat ini -- lihat backend-api ApkBuildController::generate(). */
export async function generateApkBuild(
    chatId: number,
    organizationId: number,
    apkType: string,
    version: string
): Promise<ApkBuild> {
    const response = await api.post(
        '/apk-builds/generate',
        {
            organization_id: organizationId,
            apk_type: apkType,
            version,
        },
        asChat(chatId)
    )
    return response.data.data
}

export async function getApkBuild(chatId: number, id: number): Promise<ApkBuild> {
    const response = await api.get(`/apk-builds/${encodeURIComponent(id)}`, asChat(chatId))
    return response.data.data
}

/**
 * Unduh berkas build lewat tautan bertanda tangan. Tautan itu kini dialihkan
 * (302) ke URL sementara DigitalOcean Spaces, dan kirim-lewat-URL Telegram tidak
 * menjamin mengikuti pengalihan -- jadi bot mengunduh sendiri lalu mengunggahnya.
 * Sengaja memakai axios polos, bukan `api`, agar token akun layanan tidak ikut
 * terkirim ke host Spaces.
 */
export async function downloadBuildFile(downloadUrl: string): Promise<Uint8Array> {
    const response = await axios.get<ArrayBuffer>(downloadUrl, {
        responseType: 'arraybuffer',
        maxRedirects: 5,
        timeout: 120_000,
    })
    return new Uint8Array(response.data)
}

/**
 * Ringkasan galat yang aman dimasukkan ke log. AxiosError membawa `config`
 * berisi header Authorization (token akun layanan), jadi objek galat mentah
 * TIDAK boleh diserahkan langsung ke logger.
 */
export function describeError(error: unknown) {
    if (axios.isAxiosError(error)) {
        return {
            message: error.message,
            code: error.code,
            status: error.response?.status,
            method: error.config?.method,
            url: error.config?.url,
        }
    }
    if (error instanceof Error) {
        return { message: error.message, name: error.name }
    }
    return { message: String(error) }
}

/** Pesan dari backend (bila ada) untuk ditampilkan ke operator. */
export function backendErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error) && typeof error.response?.data?.message === 'string') {
        return error.response.data.message
    }
    return 'Terjadi kesalahan, coba lagi.'
}

export function responseStatusOf(error: unknown): number | undefined {
    return axios.isAxiosError(error) ? error.response?.status : undefined
}
