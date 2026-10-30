import db from '@adonisjs/lucid/services/db'
import { APK_TYPES, type ApkType } from '#services/apk_builder'

/**
 * Padanan StoreApkBuildRequest & GenerateApkBuildRequest. Ditulis manual
 * (bukan VineJS) karena pesan error 422 harus SAMA dengan pesan bawaan
 * Laravel (APP_LOCALE=en) yang sudah dibaca dashboard, mis. "The organization
 * id field is required.", dan urutan field sama dengan urutan rules().
 *
 * Masukan sudah melewati bodyparser Adonis (string kosong -> null, sama
 * dengan ConvertEmptyStringsToNull); string di-trim seperti TrimStrings.
 */

export type ValidationErrors = Record<string, string[]>

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/** Nama atribut di pesan Laravel: organization_id -> "organization id". */
const label = (field: string) => field.replace(/_/g, ' ')

function addError(errors: ValidationErrors, field: string, message: string) {
    ;(errors[field] ??= []).push(message)
}

function normalize(value: unknown): unknown {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
}

/** Rule `required` Laravel: null, string kosong, dan array kosong dianggap tidak ada. */
function isMissing(value: unknown): boolean {
    return value === null || value === undefined || (Array.isArray(value) && value.length === 0)
}

/** Rule `integer` Laravel (filter_var FILTER_VALIDATE_INT): angka bulat atau string angka bulat. */
export function toInteger(value: unknown): number | null {
    if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
    if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) {
        const parsed = Number(value)
        return Number.isSafeInteger(parsed) ? parsed : null
    }
    return null
}

async function exists(table: string, id: number): Promise<boolean> {
    // `exists:table,id` Laravel tidak memperhatikan soft delete.
    return (await db.from(table).where('id', id).select('id').first()) !== null
}

/** Field integer wajib/opsional yang harus ada di tabel lain (`exists:table,id`). */
async function validateForeignId(
    errors: ValidationErrors,
    field: string,
    raw: unknown,
    table: string
): Promise<number | null> {
    const id = toInteger(raw)
    if (id === null) {
        addError(errors, field, `The ${label(field)} field must be an integer.`)
        return null
    }
    if (!(await exists(table, id))) {
        addError(errors, field, `The selected ${label(field)} is invalid.`)
        return null
    }
    return id
}

/** 'nullable', 'string', 'max:20', 'regex:/^\d+\.\d+\.\d+$/' */
function validateVersion(errors: ValidationErrors, raw: unknown): string | null {
    if (raw === null || raw === undefined) return null
    if (typeof raw !== 'string') {
        addError(errors, 'version', 'The version field must be a string.')
        return null
    }
    let valid = true
    if (Array.from(raw).length > 20) {
        addError(errors, 'version', 'The version field must not be greater than 20 characters.')
        valid = false
    }
    if (!VERSION_PATTERN.test(raw)) {
        addError(errors, 'version', 'The version field format is invalid.')
        valid = false
    }
    return valid ? raw : null
}

export type GenerateApkBuildInput = {
    organization_id: number
    apk_type: ApkType
    version: string | null
    device_name: string | null
}

export async function validateGenerateApkBuild(
    body: Record<string, unknown>
): Promise<{ data: GenerateApkBuildInput } | { errors: ValidationErrors }> {
    const errors: ValidationErrors = {}
    const input = {
        organization_id: normalize(body.organization_id),
        apk_type: normalize(body.apk_type),
        version: normalize(body.version),
        device_name: normalize(body.device_name),
    }

    // 'organization_id' => ['required', 'integer', 'exists:organizations,id']
    let organizationId: number | null = null
    if (isMissing(input.organization_id)) {
        addError(errors, 'organization_id', 'The organization id field is required.')
    } else {
        organizationId = await validateForeignId(
            errors,
            'organization_id',
            input.organization_id,
            'organizations'
        )
    }

    // 'apk_type' => ['required', Rule::in(['tracker', 'master', 'live', 'server'])]
    let apkType: ApkType | null = null
    if (isMissing(input.apk_type)) {
        addError(errors, 'apk_type', 'The apk type field is required.')
    } else if (APK_TYPES.includes(input.apk_type as ApkType)) {
        apkType = input.apk_type as ApkType
    } else {
        addError(errors, 'apk_type', 'The selected apk type is invalid.')
    }

    const version = validateVersion(errors, input.version)

    // 'device_name' => ['required_if:apk_type,tracker', 'nullable', 'string', 'max:255']
    const isTracker = input.apk_type === 'tracker'
    let deviceName: string | null = null
    if (isMissing(input.device_name)) {
        if (isTracker) {
            addError(
                errors,
                'device_name',
                'The device name field is required when apk type is tracker.'
            )
        }
    } else if (typeof input.device_name !== 'string') {
        addError(errors, 'device_name', 'The device name field must be a string.')
    } else if (Array.from(input.device_name).length > 255) {
        addError(
            errors,
            'device_name',
            'The device name field must not be greater than 255 characters.'
        )
    } else {
        deviceName = input.device_name
    }

    if (Object.keys(errors).length > 0) {
        return { errors }
    }

    return {
        data: {
            organization_id: organizationId!,
            apk_type: apkType!,
            version,
            device_name: deviceName,
        },
    }
}

/** Batas 'max:204800' (kilobyte) untuk berkas APK unggahan. */
export const APK_UPLOAD_MAX_KILOBYTES = 204800

/**
 * 'apk' bukan ekstensi yang dikenal Symfony Mime, jadi validasi ekstensi &
 * MIME manual -- sama seperti closure di StoreApkBuildRequest.
 */
export const ALLOWED_APK_MIMES = [
    'application/vnd.android.package-archive',
    'application/zip',
    'application/octet-stream',
]

export type UploadedApk = {
    /** Ekstensi dari nama berkas asli klien (getClientOriginalExtension). */
    clientExtension: string
    /** MIME dari isi berkas (bukan dari header klien), atau null bila tak terdeteksi. */
    mimeType: string | null
    sizeBytes: number
    isValid: boolean
}

export type StoreApkBuildInput = {
    organization_id: number
    version: string
}

/**
 * Field teks StoreApkBuildRequest + berkas apk_file. `file` = null bila
 * tidak ada berkas yang diunggah.
 */
export async function validateStoreApkBuild(
    body: Record<string, unknown>,
    file: UploadedApk | null
): Promise<{ data: StoreApkBuildInput } | { errors: ValidationErrors }> {
    const errors: ValidationErrors = {}
    const organizationRaw = normalize(body.organization_id)
    const versionRaw = normalize(body.version)

    let organizationId: number | null = null
    if (isMissing(organizationRaw)) {
        addError(errors, 'organization_id', 'The organization id field is required.')
    } else {
        organizationId = await validateForeignId(
            errors,
            'organization_id',
            organizationRaw,
            'organizations'
        )
    }

    // 'version' => ['required', 'string', 'max:20', 'regex:/^\d+\.\d+\.\d+$/']
    let version: string | null = null
    if (isMissing(versionRaw)) {
        addError(errors, 'version', 'The version field is required.')
    } else {
        version = validateVersion(errors, versionRaw)
    }

    const fileErrors = apkFileErrors(file)
    if (fileErrors.length > 0) {
        errors.apk_file = fileErrors
    }

    if (Object.keys(errors).length > 0) {
        return { errors }
    }

    return { data: { organization_id: organizationId!, version: version! } }
}

/** 'apk_file' => ['required', 'file', 'max:204800', closure ekstensi & MIME] */
export function apkFileErrors(file: UploadedApk | null): string[] {
    if (!file) {
        return ['The apk file field is required.']
    }
    if (!file.isValid) {
        return ['The apk file field must be a file.']
    }

    const errors: string[] = []
    if (file.sizeBytes / 1024 > APK_UPLOAD_MAX_KILOBYTES) {
        errors.push(
            `The apk file field must not be greater than ${APK_UPLOAD_MAX_KILOBYTES} kilobytes.`
        )
    }
    if (file.clientExtension.toLowerCase() !== 'apk') {
        errors.push('Berkas harus berekstensi .apk')
    } else if (!ALLOWED_APK_MIMES.includes(file.mimeType ?? 'application/octet-stream')) {
        errors.push('Berkas APK tidak valid')
    }
    return errors
}
