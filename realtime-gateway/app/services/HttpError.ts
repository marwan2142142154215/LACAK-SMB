import { isAxiosError } from 'axios'

/**
 * Ringkasan kegagalan permintaan HTTP yang aman dicatat. AxiosError membawa
 * config lengkap (URL + header): URL Telegram memuat token bot dan header
 * backend-api memuat Bearer token pengguna, jadi objek error mentahnya tidak
 * boleh diteruskan ke logger.
 */
export function describeHttpError(error: unknown): Record<string, unknown> {
    if (isAxiosError(error)) {
        return {
            code: error.code,
            message: error.message,
            status: error.response?.status,
        }
    }

    return { message: error instanceof Error ? error.message : String(error) }
}
