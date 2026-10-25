/**
 * Bentuk jawaban API yang sama dengan trait ApiResponse di backend-api:
 * { success, message, data } atau { success: false, message, errors }.
 */
export function success(message: string, data: unknown = null) {
    return { success: true, message, data }
}

export function fail(message: string, errors: unknown = null) {
    return { success: false, message, errors }
}
