/**
 * Label & ringkasan detail perangkat untuk menu Device dan Radar. Data asalnya dari APK Pelacak
 * (event device:info / device:location di realtime-gateway) dan status perintah dari
 * device_commands (lihat CommandLifecycle di gateway). Fungsi murni -- diuji di deviceInfo.test.js.
 */

export const COMMAND_TYPE_LABELS = {
    lock: 'Kunci',
    unlock: 'Buka kunci',
    locate_now: 'Minta lokasi',
    start_monitor: 'Mulai pantau',
    stop_monitor: 'Hentikan pantau',
}

/** Status perintah -> label + varian BaseBadge. */
export const COMMAND_STATUS = {
    pending: { label: 'Menunggu HP online', variant: 'warning' },
    delivered: { label: 'Terkirim', variant: 'neutral' },
    acknowledged: { label: 'Diterima HP', variant: 'neutral' },
    executed: { label: 'Dijalankan', variant: 'success' },
    failed: { label: 'Gagal', variant: 'danger' },
    expired: { label: 'Kedaluwarsa', variant: 'neutral' },
}

export function commandStatusMeta(status) {
    return COMMAND_STATUS[status] ?? { label: status ?? '—', variant: 'neutral' }
}

/** Perintah masih berjalan (belum ada hasil akhir dari HP)? */
export function isCommandOpen(status) {
    return status === 'pending' || status === 'delivered' || status === 'acknowledged'
}

/** Izin yang dilaporkan APK (kunci sama dengan SetupChecks.permissionState di APK). */
export const PERMISSION_LABELS = {
    location: 'Lokasi',
    backgroundLocation: 'Lokasi sepanjang waktu',
    notifications: 'Notifikasi',
    deviceAdmin: 'Kunci jarak jauh (Admin perangkat)',
    overlay: 'Tampil di atas aplikasi lain',
    batteryUnrestricted: 'Tanpa batasan baterai',
    bluetooth: 'Bluetooth (opsional)',
}

/** Izin yang wajib supaya pelacakan & kunci andal (Bluetooth opsional). */
const REQUIRED_PERMISSIONS = [
    'location',
    'backgroundLocation',
    'notifications',
    'deviceAdmin',
    'overlay',
    'batteryUnrestricted',
]

/**
 * Daftar label izin wajib yang BELUM diberikan. Device Owner otomatis memenuhi kunci jarak jauh &
 * tampil di atas app lain. null = APK belum pernah melaporkan (versi lama / belum terhubung).
 */
export function missingPermissions(state) {
    if (!state || typeof state !== 'object') return null
    const owner = state.deviceOwner === true
    return REQUIRED_PERMISSIONS.filter((key) => {
        if (owner && (key === 'deviceAdmin' || key === 'overlay')) return false
        return state[key] === false
    }).map((key) => PERMISSION_LABELS[key])
}

const NETWORK_LABELS = { wifi: 'WiFi', cellular: 'Seluler', ethernet: 'Ethernet', vpn: 'VPN', none: 'Tanpa jaringan', other: 'Lainnya' }

/** "WiFi · Kantor-1", "Seluler · Telkomsel", atau null kalau belum ada data. */
export function networkLabel(device) {
    const type = device?.network_type
    if (!type) return device?.last_ssid ? `WiFi · ${device.last_ssid}` : null
    const base = NETWORK_LABELS[type] ?? type
    if (type === 'wifi' && device.last_ssid) return `${base} · ${device.last_ssid}`
    if (type === 'cellular' && device.carrier_name) return `${base} · ${device.carrier_name}`
    return base
}

/** "samsung SM-A155F" tanpa merek ganda ("Xiaomi Xiaomi 13" -> "Xiaomi 13"). */
export function modelLabel(device) {
    const maker = device?.manufacturer?.trim()
    const model = device?.model?.trim()
    if (!maker && !model) return null
    if (!maker) return model
    if (!model) return maker
    return model.toLowerCase().startsWith(maker.toLowerCase()) ? model : `${maker} ${model}`
}

/** MB -> "1,5 GB" / "820 MB". */
export function formatMegabytes(mb) {
    if (mb == null || !Number.isFinite(Number(mb))) return null
    const value = Number(mb)
    if (value >= 1024) return `${(value / 1024).toLocaleString('id-ID', { maximumFractionDigits: 1 })} GB`
    return `${Math.round(value).toLocaleString('id-ID')} MB`
}

/** "Sisa 12 GB dari 64 GB" atau null. */
export function storageLabel(device) {
    const free = formatMegabytes(device?.storage_free_mb)
    const total = formatMegabytes(device?.storage_total_mb)
    if (!free) return null
    return total ? `Sisa ${free} dari ${total}` : `Sisa ${free}`
}

/** Penyimpanan hampir penuh (< 10% atau < 1 GB) -- aplikasi bisa gagal menyimpan data. */
export function isStorageLow(device) {
    const free = Number(device?.storage_free_mb)
    const total = Number(device?.storage_total_mb)
    if (!Number.isFinite(free) || device?.storage_free_mb == null) return false
    return free < 1024 || (Number.isFinite(total) && total > 0 && free / total < 0.1)
}

/**
 * Mode pengelolaan HP dari permission_state yang dilaporkan APK:
 * - 'owner'  : Device Owner (HP aset perusahaan penuh) — lokasi & uninstall bisa dikunci.
 * - 'admin'  : Device Admin saja — hanya kunci layar jarak jauh.
 * - 'biasa'  : terpasang seperti aplikasi biasa.
 * null = APK belum pernah melaporkan status izin.
 */
export function managementMode(state) {
    if (!state || typeof state !== 'object') return null
    if (state.deviceOwner === true) return 'owner'
    if (state.deviceAdmin === true) return 'admin'
    return 'biasa'
}

const MANAGEMENT_LABELS = {
    owner: 'Device Owner (aset perusahaan)',
    admin: 'Device Admin (kunci layar saja)',
    biasa: 'Aplikasi biasa',
}

export function managementModeLabel(state) {
    const mode = managementMode(state)
    return mode ? MANAGEMENT_LABELS[mode] : null
}

/**
 * Baris status kebijakan kunci perusahaan untuk kartu "Kontrol perusahaan" di detail perangkat.
 * value true/false kalau dilaporkan HP, null = belum dilaporkan (APK versi lama / belum terhubung).
 * tone 'ok' saat terkunci (sesuai tujuan aset perusahaan), 'warn' saat tidak terkunci.
 */
export function policyLockRows(device) {
    if (!device) return []
    const lockRow = (label, value) => ({
        label,
        value: value == null ? null : value === true,
        text: value == null ? 'Belum dilaporkan' : value === true ? 'Terkunci' : 'Tidak terkunci',
        tone: value == null ? 'muted' : value === true ? 'ok' : 'warn',
    })
    return [
        lockRow('Lokasi/GPS dikunci menyala', device.location_policy_locked),
        lockRow('Aplikasi dikunci (anti-hapus)', device.uninstall_locked),
    ]
}

/** HP non-Device-Owner yang lokasinya sedang dimatikan pemegang HP (perlu dinyalakan lagi). */
export function isLocationServiceOff(device) {
    return device?.location_service_on === false
}

const PROVIDER_LABELS = { gps: 'GPS', network: 'Jaringan', fused: 'Gabungan', passive: 'Pasif' }

/** "GPS · ±12 m" / "Jaringan · ±850 m" / null. */
export function locationQualityLabel(location) {
    if (!location) return null
    const provider = PROVIDER_LABELS[location.location_provider] ?? null
    const accuracy = location.accuracy_meters != null ? `±${Math.round(Number(location.accuracy_meters))} m` : null
    const parts = [provider, accuracy].filter(Boolean)
    return parts.length ? parts.join(' · ') : null
}
