import { DateTime } from 'luxon'
import GeofenceRule from '#models/geofence_rule'
import ViolationLog from '#models/violation_log'
import DeviceCommand from '#models/device_command'
import socketManager from '#services/socket_manager'
import { getSystemUserId } from '#services/system_user'
import { notifyTelegramViolation } from '#services/telegram_notifier'
import type Device from '#models/device'

type LocationReport = {
  ssid?: string | null
  ip?: string | null
  bleDistanceMeters?: number | null
  latitude?: number | null
  longitude?: number | null
}

/**
 * Cek laporan posisi device terhadap whitelist WiFi/IP + radius GPS dari
 * titik pusat site-nya. Pelanggaran dicatat ke violation_logs dan disiarkan
 * ke dashboard. Pelanggaran memicu auto-lock sebagai jaring pengaman sisi
 * server; kalau device kembali ke dalam radius aman (dan kuncinya memang
 * dipasang otomatis, bukan oleh admin), device dibuka otomatis juga.
 *
 * CATATAN PENTING: jarak dihitung dari GPS (latitude/longitude, dikirim tiap
 * heartbeat 30 detik), BUKAN dari ble_distance_meters. Tracker app cuma
 * MEMANCARKAN beacon BLE (lihat BleBeaconAdvertiser di android-tracked-app),
 * tidak pernah men-SCAN jarak dari anchor manapun -- tidak ada hardware
 * anchor BLE fisik di sistem ini, jadi ble_distance_meters SELALU null dan
 * cek jarak berbasis itu tidak akan pernah menyala sendiri. GPS sudah
 * tersedia tanpa hardware tambahan apa pun, makanya itu yang dipakai untuk
 * auto-lock/auto-unlock sungguhan.
 */
export async function evaluateGeofence(device: Device, report: LocationReport) {
  const rules = await GeofenceRule.query()
    .where('organization_id', device.organizationId)
    .where('is_active', true)

  if (rules.length === 0) return

  let anyViolated = false
  let hasEvaluableSignal = false

  for (const rule of rules) {
    if (rule.allowedSsid && report.ssid) {
      hasEvaluableSignal = true
      if (report.ssid !== rule.allowedSsid) {
        anyViolated = true
        await recordViolation(device, rule, 'wifi_mismatch', report.ssid)
        await autoLock(device, rule)
        continue
      }
    }

    if (rule.allowedIpCidr && report.ip) {
      hasEvaluableSignal = true
      if (!ipInCidr(report.ip, rule.allowedIpCidr)) {
        anyViolated = true
        await recordViolation(device, rule, 'ip_mismatch', report.ip)
        await autoLock(device, rule)
        continue
      }
    }

    if (
      rule.maxDistanceMeters &&
      rule.centerLatitude !== null &&
      rule.centerLongitude !== null &&
      report.latitude !== null &&
      report.latitude !== undefined &&
      report.longitude !== null &&
      report.longitude !== undefined
    ) {
      hasEvaluableSignal = true
      const distance = haversineMeters(
        rule.centerLatitude,
        rule.centerLongitude,
        report.latitude,
        report.longitude
      )

      if (distance > rule.maxDistanceMeters) {
        anyViolated = true
        const detail = `${Math.round(distance)}m dari titik pusat (maks ${rule.maxDistanceMeters}m)`

        // GPS HP TIDAK presisi sampai hitungan meter -- satu pembacaan yang
        // melenceng jauh (umum terjadi pas GPS baru dapat sinyal ulang
        // setelah idle/di dalam ruangan) sendirian TIDAK memicu lock. Baru
        // mengunci kalau laporan SEBELUMNYA untuk aturan yang sama juga
        // sudah melanggar -- dua kali berturut-turut (~kurang dari 1 menit)
        // jauh lebih kecil kemungkinan cuma noise GPS sesaat.
        const previousViolation = await ViolationLog.query()
          .where('device_id', device.id)
          .where('geofence_rule_id', rule.id)
          .where('violation_type', 'distance_exceeded')
          .where('detected_at', '>=', DateTime.now().minus({ seconds: 90 }).toJSDate())
          .orderBy('detected_at', 'desc')
          .first()

        await recordViolation(device, rule, 'distance_exceeded', detail)

        if (previousViolation) {
          await autoLock(device, rule)
        }
      }
    }
  }

  // Cuma buka otomatis kalau ADA sinyal yang benar-benar dicek dan SEMUANYA
  // sesuai aturan -- bukan cuma karena laporan ini kebetulan tidak membawa
  // data (mis. ssid kosong), yang seharusnya tidak dianggap "aman".
  if (!anyViolated && hasEvaluableSignal) {
    await autoUnlockIfSafeToReturn(device)
  }
}

async function recordViolation(
  device: Device,
  rule: GeofenceRule,
  type: 'wifi_mismatch' | 'ip_mismatch' | 'distance_exceeded',
  detectedValue: string
) {
  const violationLabel = {
    wifi_mismatch: 'WiFi di luar whitelist',
    ip_mismatch: 'IP di luar whitelist',
    distance_exceeded: 'Melewati radius aman',
  }[type]

  const telegramText = [
    '⚠️ Pelanggaran terdeteksi — Lacak SMB',
    `Device: ${device.deviceName}`,
    `Aturan: ${rule.ruleName}`,
    `Jenis: ${violationLabel}`,
    `Detail: ${detectedValue}`,
  ].join('\n')

  const notifiedTelegram = await notifyTelegramViolation(device.organizationId, telegramText)

  const log = await ViolationLog.create({
    deviceId: device.id,
    geofenceRuleId: rule.id,
    violationType: type,
    detectedValue,
    notifiedTelegram,
    notifiedDashboard: true,
    detectedAt: DateTime.now(),
  })

  socketManager.broadcastViolation(device.organizationId, {
    device_id: device.id,
    device_name: device.deviceName,
    rule_name: rule.ruleName,
    violation_type: type,
    detected_value: detectedValue,
    detected_at: log.detectedAt,
  })
}

/**
 * Jaring pengaman: kalau device melewati radius aman dari titik pusat, server
 * langsung mengeluarkan perintah 'lock' (bukan menunggu admin klik), sesuai
 * permintaan awal "jika sudah lewat jarak maka lock hp". Dicatat ke
 * device_commands dengan issued_via='system_auto' dan issued_by=akun
 * system-automation supaya tetap ada jejak audit yang jujur.
 */
async function autoLock(device: Device, rule: GeofenceRule) {
  if (device.status === 'locked') return

  const systemUserId = await getSystemUserId()
  const reasonNote = `Otomatis: melewati radius aman aturan "${rule.ruleName}"`

  await DeviceCommand.create({
    deviceId: device.id,
    commandType: 'lock',
    issuedBy: systemUserId,
    issuedVia: 'system_auto',
    status: 'pending',
    reasonNote,
    createdAt: DateTime.now(),
  })

  device.status = 'locked'
  await device.save()

  // Pengiriman aktual ke device dilakukan satu-satunya oleh command_dispatcher
  // (poll device_commands 'pending') supaya tidak ada pengiriman dobel.
  socketManager.broadcastDeviceStatus(device.organizationId, {
    device_id: device.id,
    status: 'locked',
    reason: 'auto_lock_distance_exceeded',
  })
}

/**
 * Kebalikan dari autoLock: device yang terkunci OTOMATIS (bukan dikunci
 * admin secara sengaja) dan sekarang sudah kembali ke semua radius aman
 * dibuka lagi otomatis -- sesuai permintaan "kalau kembali ke jarak aman,
 * baru dia kebuka". SENGAJA memeriksa riwayat command terakhir dulu: kalau
 * kunci terakhir itu manual (issued_via dari admin, bukan system_auto),
 * TIDAK dibuka otomatis -- cuma admin (atau OTP staf) yang boleh membuka
 * kunci yang sengaja mereka pasang.
 */
async function autoUnlockIfSafeToReturn(device: Device) {
  if (device.status !== 'locked') return

  const lastLockOrUnlock = await DeviceCommand.query()
    .where('device_id', device.id)
    .whereIn('command_type', ['lock', 'unlock'])
    .orderBy('created_at', 'desc')
    .first()

  if (!lastLockOrUnlock) return
  if (lastLockOrUnlock.commandType !== 'lock') return
  if (lastLockOrUnlock.issuedVia !== 'system_auto') return

  const systemUserId = await getSystemUserId()

  await DeviceCommand.create({
    deviceId: device.id,
    commandType: 'unlock',
    issuedBy: systemUserId,
    issuedVia: 'system_auto',
    status: 'pending',
    reasonNote: 'Otomatis: device kembali ke radius aman',
    createdAt: DateTime.now(),
  })

  device.status = 'online'
  await device.save()

  await notifyTelegramViolation(
    device.organizationId,
    ['✅ Kembali ke radius aman — Lacak SMB', `Device: ${device.deviceName}`, 'Dibuka otomatis.'].join('\n')
  )

  socketManager.broadcastDeviceStatus(device.organizationId, {
    device_id: device.id,
    status: 'online',
    reason: 'auto_unlock_within_safe_radius',
  })
}

/** Jarak great-circle antara dua titik lat/lng dalam meter (rumus haversine). */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000 // radius bumi, meter
  const toRad = (deg: number) => (deg * Math.PI) / 180

  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)

  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return R * c
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/')
  const bits = Number.parseInt(bitsStr ?? '32', 10)

  const ipToLong = (addr: string) =>
    addr.split('.').reduce((acc, octet) => (acc << 8) + Number.parseInt(octet, 10), 0) >>> 0

  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0

  return (ipToLong(ip) & mask) === (ipToLong(range) & mask)
}
