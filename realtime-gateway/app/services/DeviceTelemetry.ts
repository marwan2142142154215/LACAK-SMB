import { DateTime } from 'luxon'

/**
 * Pembersih data yang dikirim APK Pelacak (payload socket = TIDAK tepercaya). Hanya field yang
 * diungkapkan ke pemegang HP di layar APK yang diterima -- field lain di payload diabaikan, jadi
 * APK yang dimodifikasi pun tidak bisa menyelipkan data tambahan ke database.
 */

/** Jenis jaringan yang dikenali; nilai lain dari APK disimpan sebagai 'other'. */
export const NETWORK_TYPES = ['wifi', 'cellular', 'ethernet', 'vpn', 'none', 'other'] as const

/** Izin/status yang dilaporkan APK (true = sudah diberikan/aktif). */
export const PERMISSION_KEYS = [
    'location',
    'backgroundLocation',
    'notifications',
    'bluetooth',
    'deviceAdmin',
    'deviceOwner',
    'batteryUnrestricted',
    'overlay',
] as const

export type PermissionState = Partial<Record<(typeof PERMISSION_KEYS)[number], boolean>>

export type DeviceInfo = {
    manufacturer: string | null
    model: string | null
    androidVersion: string | null
    appVersionName: string | null
    appVersionCode: number | null
    batteryLevel: number | null
    isCharging: boolean | null
    networkType: (typeof NETWORK_TYPES)[number] | null
    carrierName: string | null
    storageFreeMb: number | null
    storageTotalMb: number | null
    permissions: PermissionState | null
    // Kebijakan kunci HP aset perusahaan (Device Owner) -- true/false bila dilaporkan, null bila tidak.
    locationPolicyLocked: boolean | null
    uninstallLocked: boolean | null
    locationServiceOn: boolean | null
}

/** Teks bebas: dipangkas, karakter kontrol dibuang, dipotong ke panjang kolom; kosong = null. */
export function cleanText(value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') return null
    // eslint-disable-next-line no-control-regex
    const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
    if (text === '') return null
    return Array.from(text).slice(0, maxLength).join('')
}

/** Bilangan bulat dalam rentang [min, max]; di luar itu atau bukan angka = null. */
export function cleanInt(value: unknown, min: number, max: number): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    const int = Math.round(value)
    return int >= min && int <= max ? int : null
}

/** Bilangan pecahan dalam rentang [min, max]; di luar itu atau bukan angka = null. */
export function cleanNumber(value: unknown, min: number, max: number): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    return value >= min && value <= max ? value : null
}

function cleanBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null
}

export function cleanPermissions(value: unknown): PermissionState | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const source = value as Record<string, unknown>
    const result: PermissionState = {}
    for (const key of PERMISSION_KEYS) {
        if (typeof source[key] === 'boolean') result[key] = source[key] as boolean
    }
    return Object.keys(result).length ? result : null
}

/** Payload `device:info` dari APK -> nilai yang boleh disimpan (panjang mengikuti kolom DB). */
export function sanitizeDeviceInfo(payload: unknown): DeviceInfo {
    const data = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
    const network = typeof data.networkType === 'string' ? data.networkType.toLowerCase() : null
    return {
        manufacturer: cleanText(data.manufacturer, 100),
        model: cleanText(data.model, 100),
        // devices.android_version varchar(10), app_build_version varchar(20).
        androidVersion: cleanText(data.androidVersion, 10),
        appVersionName: cleanText(data.appVersionName, 20),
        appVersionCode: cleanInt(data.appVersionCode, 0, 2_100_000_000),
        batteryLevel: cleanInt(data.batteryLevel, 0, 100),
        isCharging: cleanBoolean(data.isCharging),
        networkType:
            network === null
                ? null
                : (NETWORK_TYPES as readonly string[]).includes(network)
                  ? (network as DeviceInfo['networkType'])
                  : 'other',
        carrierName: cleanText(data.carrierName, 100),
        // Batas 100 TB (dalam MB) -- angka lebih besar pasti salah.
        storageFreeMb: cleanInt(data.storageFreeMb, 0, 100_000_000),
        storageTotalMb: cleanInt(data.storageTotalMb, 0, 100_000_000),
        permissions: cleanPermissions(data.permissions),
        locationPolicyLocked: cleanBoolean(data.locationPolicyLocked),
        uninstallLocked: cleanBoolean(data.uninstallLocked),
        locationServiceOn: cleanBoolean(data.locationServiceOn),
    }
}

/** Sumber fix lokasi Android yang dikenali. */
export const LOCATION_PROVIDERS = ['gps', 'network', 'fused', 'passive'] as const

export type LocationExtras = {
    accuracyMeters: number | null
    provider: (typeof LOCATION_PROVIDERS)[number] | null
    fixedAt: DateTime | null
}

/** Fix lebih tua dari ini dianggap tidak masuk akal (jam HP salah) dan waktunya dibuang. */
const MAX_FIX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Toleransi jam HP yang sedikit lebih cepat dari server. */
const MAX_FIX_FUTURE_MS = 5 * 60 * 1000

/** Akurasi, sumber, dan waktu fix dari payload `device:location`. */
export function sanitizeLocationExtras(
    payload: unknown,
    now: DateTime = DateTime.now()
): LocationExtras {
    const data = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
    const provider = typeof data.provider === 'string' ? data.provider.toLowerCase() : null
    const fixTimeMs = cleanNumber(data.fixTime, 0, Number.MAX_SAFE_INTEGER)
    let fixedAt: DateTime | null = null
    if (fixTimeMs !== null) {
        const delta = now.toMillis() - fixTimeMs
        if (delta <= MAX_FIX_AGE_MS && delta >= -MAX_FIX_FUTURE_MS) {
            fixedAt = DateTime.fromMillis(Math.min(fixTimeMs, now.toMillis()))
        }
    }
    return {
        // numeric(8,2): maksimum 999999.99 meter.
        accuracyMeters: (() => {
            const value = cleanNumber(data.accuracyMeters, 0, 999_999.99)
            return value === null ? null : Math.round(value * 100) / 100
        })(),
        provider: (LOCATION_PROVIDERS as readonly string[]).includes(provider ?? '')
            ? (provider as LocationExtras['provider'])
            : null,
        fixedAt,
    }
}

/** Sumber lokasi yang diterima kolom device_locations.source (CHECK di database). */
export const LOCATION_SOURCES = ['ble', 'gps', 'ble_estimated'] as const

export type LocationReport = {
    /** null = sumber tidak dikenal; laporan seperti itu harus dibuang (database menolaknya). */
    source: (typeof LOCATION_SOURCES)[number] | null
    bleDistanceMeters: number | null
    bleRssi: number | null
    batteryLevel: number | null
    /** undefined = payload tidak membawa ssid (nama terakhir dipertahankan); null/'' = tidak terhubung WiFi. */
    ssid: string | null | undefined
    ip: string | null
    nearbyBeaconUuid: string | null
    nearbyBeaconDistanceMeters: number | null
}

/**
 * Teks apa adanya (tanpa trim) dipotong ke panjang batas; bukan teks = null. Dipakai untuk SSID/IP yang
 * dicocokkan geofence, jadi isinya tidak boleh berubah selain dipotong.
 */
function plainText(value: unknown, maxLength: number): string | null {
    return typeof value === 'string' ? Array.from(value).slice(0, maxLength).join('') : null
}

/**
 * Bagian payload `device:location` selain koordinat: tiap nilai dibatasi ke tipe & rentang kolom
 * databasenya, supaya satu nilai ngawur dari APK tidak membatalkan seluruh fix lokasi (transaksi
 * simpan gagal) dan tidak ikut disiarkan ke dashboard.
 */
export function sanitizeLocationReport(payload: unknown): LocationReport {
    const data = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
    const source = (LOCATION_SOURCES as readonly string[]).includes(String(data.source))
        ? (data.source as LocationReport['source'])
        : null
    return {
        source,
        // numeric(6,2): maksimum 9999.99 meter.
        bleDistanceMeters: cleanNumber(data.bleDistanceMeters, 0, 9999.99),
        // smallint; RSSI BLE nyata berkisar sekitar -100..0.
        bleRssi: cleanInt(data.bleRssi, -200, 0),
        batteryLevel: cleanInt(data.batteryLevel, 0, 100),
        ssid:
            data.ssid === undefined
                ? undefined
                : typeof data.ssid === 'string' || data.ssid === null
                  ? plainText(data.ssid, 255)
                  : undefined,
        ip: plainText(data.ip, 45),
        nearbyBeaconUuid: plainText(data.nearbyBeaconUuid, 64),
        nearbyBeaconDistanceMeters: cleanNumber(data.nearbyBeaconDistanceMeters, 0, 1_000_000),
    }
}

/** Koordinat valid (lintang -90..90, bujur -180..180); selain itu dibuang jadi null. */
export function cleanCoordinate(value: unknown, limit: 90 | 180): number | null {
    return cleanNumber(value, -limit, limit)
}
