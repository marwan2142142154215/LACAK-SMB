import { DateTime } from 'luxon'
import GeofenceRule from '#models/geofence_rule'
import ViolationLog from '#models/violation_log'
import DeviceCommand from '#models/device_command'
import socketManager from '#services/socket_manager'
import { getSystemUserId } from '#services/system_user'
import type Device from '#models/device'

type LocationReport = {
  ssid?: string | null
  ip?: string | null
  bleDistanceMeters?: number | null
}

/**
 * Cek laporan posisi device terhadap whitelist WiFi/IP + jarak BLE maksimum
 * site-nya. Pelanggaran dicatat ke violation_logs dan disiarkan ke dashboard
 * ("standar" permintaan awal: fitur tambah site +ip +nama wifi yang
 * diizinkan). Pelanggaran jarak BLE juga memicu auto-lock sebagai jaring
 * pengaman sisi server, selain logika on-device.
 */
export async function evaluateGeofence(device: Device, report: LocationReport) {
  const rules = await GeofenceRule.query()
    .where('organization_id', device.organizationId)
    .where('is_active', true)

  for (const rule of rules) {
    if (rule.allowedSsid && report.ssid && report.ssid !== rule.allowedSsid) {
      await recordViolation(device, rule, 'wifi_mismatch', report.ssid)
      continue
    }

    if (rule.allowedIpCidr && report.ip && !ipInCidr(report.ip, rule.allowedIpCidr)) {
      await recordViolation(device, rule, 'ip_mismatch', report.ip)
      continue
    }

    if (
      rule.maxDistanceMeters &&
      report.bleDistanceMeters !== null &&
      report.bleDistanceMeters !== undefined &&
      report.bleDistanceMeters > rule.maxDistanceMeters
    ) {
      await recordViolation(
        device,
        rule,
        'distance_exceeded',
        `${report.bleDistanceMeters}m (maks ${rule.maxDistanceMeters}m)`
      )
      await autoLock(device, rule)
    }
  }
}

async function recordViolation(
  device: Device,
  rule: GeofenceRule,
  type: 'wifi_mismatch' | 'ip_mismatch' | 'distance_exceeded',
  detectedValue: string
) {
  const log = await ViolationLog.create({
    deviceId: device.id,
    geofenceRuleId: rule.id,
    violationType: type,
    detectedValue,
    notifiedTelegram: false, // bot Telegram mengambil/mem-poll ini di tahap berikutnya
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
 * Jaring pengaman: kalau device melewati jarak maksimum dari anchor, server
 * langsung mengeluarkan perintah 'lock' (bukan menunggu admin klik), sesuai
 * permintaan awal "jika sudah lewat jarak maka lock hp". Dicatat ke
 * device_commands dengan issued_via='system_auto' dan issued_by=akun
 * system-automation supaya tetap ada jejak audit yang jujur.
 */
async function autoLock(device: Device, rule: GeofenceRule) {
  if (device.status === 'locked') return

  const systemUserId = await getSystemUserId()
  const reasonNote = `Otomatis: melewati jarak maksimum aturan "${rule.ruleName}"`

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

function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/')
  const bits = Number.parseInt(bitsStr ?? '32', 10)

  const ipToLong = (addr: string) =>
    addr.split('.').reduce((acc, octet) => (acc << 8) + Number.parseInt(octet, 10), 0) >>> 0

  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0

  return (ipToLong(ip) & mask) === (ipToLong(range) & mask)
}
