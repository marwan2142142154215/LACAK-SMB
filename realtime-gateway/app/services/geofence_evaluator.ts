import { DateTime } from 'luxon'
import GeofenceRule from '#models/geofence_rule'
import ViolationLog from '#models/violation_log'
import DeviceCommand from '#models/device_command'
import socketManager from '#services/socket_manager'
import { getSystemUserId } from '#services/system_user'
import { notifyTelegramViolation } from '#services/telegram_notifier'
import Device from '#models/device'

type LocationReport = {
  ssid?: string | null
  ip?: string | null
  bleDistanceMeters?: number | null
  latitude?: number | null
  longitude?: number | null
}

/**
 * Histeresis unlock: pembacaan dianggap "bukti kembali ke radius aman" hanya
 * kalau jaraknya <= UNLOCK_SAFE_RATIO x maxDistance (radius 10m -> harus
 * <= 7m), bukan sekadar <= radius. Jadi ada pita mati 7-10m: di pita itu
 * device TIDAK dianggap melanggar (tidak menambah log), tapi juga TIDAK
 * menghitung maju menuju auto-unlock -- fluktuasi noise di sekitar ambang
 * tidak bisa bolak-balik lock/unlock.
 */
const UNLOCK_SAFE_RATIO = 0.7

// Tiap laporan = 1 heartbeat (~15 detik, lihat HEARTBEAT_INTERVAL_MS di
// TrackerForegroundService.kt). 3 sebelumnya (~90 detik tunggu) terasa
// "macet"/tidak pernah terbuka untuk user yang menunggu persis di depan HP
// setelah kembali -- 2 (~30 detik) masih menolak satu bacaan dekat yang
// kebetulan (bukan auto-unlock sekali bacaan), tapi jauh lebih responsif.
/** Jumlah laporan BERTURUT-TURUT yang semuanya aman (dan di bawah histeresis) sebelum auto-unlock. */
const UNLOCK_SAFE_STREAK_REQUIRED = 2

/** Gap minimal antar laporan yang dihitung maju streak -- menahan heartbeat dobel/beruntun (< 5 detik) supaya bukti berturut-turut tidak bisa dipalsukan oleh pengiriman ganda. */
const MIN_SAFE_STREAK_GAP_MS = 5_000

/** Kalau jeda antar laporan aman lebih dari ini, streak dianggap putus dan mulai dari 1 lagi. */
const MAX_SAFE_STREAK_GAP_MS = 120_000

/** device id -> jumlah laporan aman berturut-turut + waktu laporan terakhir yang dihitung. */
const safeReturnStreaks = new Map<number, { count: number; lastAt: number }>()

/**
 * Grace period setelah jeda laporan yang tidak wajar (> WARMUP_AFTER_GAP_MS:
 * pertama kali terlihat, app/service baru restart, gateway baru restart, atau
 * heartbeat sempat putus). Selama jendela WARMUP_DURATION_MS setelahnya,
 * ble_distance_meters null dipakai sebagai "scanner BLE baru mulai, paket
 * pertama anchor belum masuk" -- BUKAN pelanggaran. Tanpa ini, setiap restart
 * app selalu menghasilkan 1-2 log pelanggaran "anchor tidak terdeteksi" palsu
 * + pesan Telegram, dan restart dua kali berturut dalam 2 menit bisa mengunci
 * device yang sebenarnya duduk di sebelah anchor.
 */
const WARMUP_AFTER_GAP_MS = 45_000
const WARMUP_DURATION_MS = 90_000
const lastReportAtByDevice = new Map<number, number>()
const warmupUntilByDevice = new Map<number, number>()

/**
 * Antrian evaluasi per device: laporan dari device yang sama diproses SATU
 * PER SATU, tidak paralel. Dua laporan hampir bersamaan dulu bisa berlomba di
 * recordViolation/autoLock: dua pesan Telegram kembar terkirim (keduanya
 * menang race cek throttle), dua perintah lock dobel dibuat (yang kedua masih
 * memegang status 'online' basi dari query sendiri), dan deteksi "pelanggaran
 * kedua" jadi tidak konsisten. Dengan antrian, laporan kedua selalu melihat
 * hasil lengkap laporan pertama.
 */
const evaluationQueues = new Map<number, Promise<void>>()

/** Kabari Telegram pelanggaran maksimal sekali per 10 menit per aturan -- selama device terus jauh, heartbeat 30 detik akan memicu pelanggaran baru terus-menerus. */
const TELEGRAM_NOTIFY_MIN_INTERVAL_MS = 10 * 60 * 1000

/**
 * Cek laporan posisi device terhadap whitelist WiFi/IP + radius GPS dari
 * titik pusat site-nya. Pelanggaran dicatat ke violation_logs dan disiarkan
 * ke dashboard. Pelanggaran memicu auto-lock sebagai jaring pengaman sisi
 * server; kalau device kembali ke dalam radius aman (dan kuncinya memang
 * dipasang otomatis, bukan oleh admin), device dibuka otomatis juga.
 *
 * Jarak dicek dua jalur yang independen: GPS dari titik pusat (latitude/
 * longitude, dikirim tiap heartbeat 30 detik) ATAU jarak BLE dari anchor
 * (mode anchor: device scan beacon anchor, distance diestimasi dari RSSI --
 * lihat BleBeaconScanner di android-tracked-app). Kalau rule punya keduanya,
 * device harus lolos keduanya.
 *
 * AUTO-UNLOCK SENGAJA LEBIH SULIT DARI AUTO-LOCK (histeresis + konfirmasi
 * berturut-turut): lock cukup 2 pelanggaran dalam 120 detik, tapi unlock
 * butuh UNLOCK_SAFE_STREAK_REQUIRED laporan BERTURUT-TURUT yang semuanya
 * jauh di bawah ambang (<= UNLOCK_SAFE_RATIO x maxDistance) -- pembacaan
 * RSSI/GPS yang berfluktuasi di sekitar ambang radius (mis. 6-9m untuk
 * radius 10m) jadi TIDAK bisa membuka kunci sendirian. Tanpa ini, device
 * yang benar-benar jauh tapi kebetulan mendapat satu pembacaan "dekat"
 * (noise multipath di ambang) langsung kebuka otomatis -- bug yang sempat
 * teramati di produksi (unlock setelah satu bacaan 6.31m padahal device
 * masih jauh dari anchor).
 *
 * State streak disimpan di memori proses gateway (satu instance, lihat
 * server-gui/lacak_server.py) -- cukup karena yang dibutuhkan cuma bukti
 * "beberapa heartbeat terakhir berturut-turut", bukan riwayat jangka panjang.
 */
export function evaluateGeofence(device: Device, report: LocationReport): Promise<void> {
  const previous = evaluationQueues.get(device.id) ?? Promise.resolve()

  // Chained lewat handler penolak juga: satu evaluasi yang error tidak boleh
  // mematikan antrian device-nya selamanya.
  const next = previous.then(
    () => evaluateGeofenceNow(device, report),
    () => evaluateGeofenceNow(device, report)
  )

  const settled = next.then(
    () => {},
    () => {}
  )
  evaluationQueues.set(device.id, settled)
  settled.then(() => {
    // Bersihkan diri sendiri kalau sudah jadi antrian terakhir -- map tidak
    // tumbuh untuk device yang sudah tidak pernah melapor lagi.
    if (evaluationQueues.get(device.id) === settled) {
      evaluationQueues.delete(device.id)
    }
  })

  return next
}

async function evaluateGeofenceNow(device: Device, report: LocationReport) {
  const now = Date.now()
  const previousReportAt = lastReportAtByDevice.get(device.id)
  lastReportAtByDevice.set(device.id, now)

  if (previousReportAt === undefined || now - previousReportAt > WARMUP_AFTER_GAP_MS) {
    warmupUntilByDevice.set(device.id, now + WARMUP_DURATION_MS)
  }
  const inBleWarmup = (warmupUntilByDevice.get(device.id) ?? 0) > now

  const rules = await GeofenceRule.query()
    .where('organization_id', device.organizationId)
    .where('is_active', true)

  if (rules.length === 0) return

  let anyViolated = false
  let hasEvaluableSignal = false

  /**
   * True selama SEMUA sinyal yang benar-benar dicek lolos dengan margin
   * histeresis (lihat UNLOCK_SAFE_RATIO). Sengaja dipisah dari anyViolated:
   * pembacaan di pita 7-10m tidak melanggar, tapi juga bukan bukti aman.
   */
  let safeForUnlock = true

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
      } else if (distance > rule.maxDistanceMeters * UNLOCK_SAFE_RATIO) {
        // Pita histeresis GPS: belum melewati radius (tidak dicatat sebagai
        // pelanggaran), tapi belum cukup jauh di dalam radius untuk dihitung
        // sebagai bukti kembali ke area aman -- lihat UNLOCK_SAFE_RATIO.
        safeForUnlock = false
      }
    }

    // Mode BLE (presisi jarak dekat, lihat socket.ts device:hello yang
    // mengirim bleAnchorUuid ke device supaya dia scan sendiri) -- device
    // melaporkan ble_distance_meters hasil estimasi dari RSSI sinyal anchor.
    // SENGAJA dicek terpisah dari GPS (keduanya independen; kalau rule punya
    // dua-duanya, device harus lolos keduanya -- lebih ketat, bukan masalah).
    if (rule.maxDistanceMeters && rule.anchorDeviceId !== null && rule.anchorDeviceId !== device.id) {
      const bleMissing =
        report.bleDistanceMeters === null || report.bleDistanceMeters === undefined

      if (bleMissing && inBleWarmup) {
        // null TAPI masih dalam masa warm-up (lihat WARMUP_*_MS di atas):
        // scanner baru mulai, paket pertama anchor belum masuk -- ini bukan
        // bukti device jauh, jangan dicatat sebagai pelanggaran. Tapi juga
        // jangan dianggap aman: safeForUnlock dipaksa false supaya streak
        // unlock tidak maju tanpa bukti BLE yang valid.
        safeForUnlock = false
      } else {
        hasEvaluableSignal = true

        // bleDistanceMeters null/undefined = anchor sudah sama sekali tidak
        // terdeteksi (keluar jangkauan BLE, ~10-30m tergantung hardware, atau
        // Bluetooth anchor mati) -- BleBeaconScanner android sudah dibuat
        // melupakan RSSI yang lebih tua dari 15 detik (lihat READING_MAX_AGE_MS),
        // jadi null di sini BUKAN cuma "belum ada data", tapi "anchor hilang".
        // Diperlakukan sama seperti melebihi radius -- kalau tidak, device yang
        // benar-benar pergi jauh (sinyal putus total) malah TIDAK PERNAH terkunci.
        const isOutOfRange = bleMissing || report.bleDistanceMeters! > rule.maxDistanceMeters

        if (isOutOfRange) {
          anyViolated = true
          const detail =
            report.bleDistanceMeters === null || report.bleDistanceMeters === undefined
              ? `anchor BLE tidak terdeteksi (maks ${rule.maxDistanceMeters}m)`
              : `${report.bleDistanceMeters.toFixed(1)}m dari anchor BLE (maks ${rule.maxDistanceMeters}m)`

          // RSSI sekarang sudah dihaluskan dengan MEDIAN jendela 15 detik di
          // sisi Android (lihat BleBeaconScanner), tapi tetap kasih jendela
          // konfirmasi sedikit lebih lega dari GPS (120 detik ~ 4 heartbeat,
          // bukan 90) -- dua pelanggaran yang terpisah >90 detik (gara-gara
          // satu pembacaan bagus nyelip di antaranya) tidak pernah berpasangan
          // sehingga device yang sungguhan sudah jauh melebihi radius TIDAK
          // PERNAH terkunci.
          const previousBleViolation = await ViolationLog.query()
            .where('device_id', device.id)
            .where('geofence_rule_id', rule.id)
            .where('violation_type', 'distance_exceeded')
            .where('detected_at', '>=', DateTime.now().minus({ seconds: 120 }).toJSDate())
            .orderBy('detected_at', 'desc')
            .first()

          await recordViolation(device, rule, 'distance_exceeded', detail)

          if (previousBleViolation) {
            await autoLock(device, rule)
          }
        } else if (
          report.bleDistanceMeters !== null &&
          report.bleDistanceMeters !== undefined &&
          report.bleDistanceMeters > rule.maxDistanceMeters * UNLOCK_SAFE_RATIO
        ) {
          // Pita histeresis BLE: anchor terdeteksi dan masih di dalam radius
          // (tidak melanggar), tapi jaraknya belum cukup kecil untuk dihitung
          // sebagai bukti kembali -- noise RSSI di ambang 7-10m tidak bisa
          // menggeser streak unlock.
          safeForUnlock = false
        }
      }
    }
  }

  // Syarat buka otomatis (semua harus terpenuhi):
  // 1. ADA sinyal yang benar-benar dicek (bukan cuma laporan kosong),
  // 2. SEMUANYA sesuai aturan (tidak ada pelanggaran),
  // 3. SEMUANYA lolos margin histeresis (safeForUnlock),
  // 4. Itu terjadi BERTURUT-TURUT minimal UNLOCK_SAFE_STREAK_REQUIRED
  //    kali -- satu pembacaan "dekat" yang kebetulan di tengah device jauh
  //    tidak cukup, streak langsung reset begitu ada pelanggaran/pita abu.
  if (anyViolated || !hasEvaluableSignal || !safeForUnlock) {
    safeReturnStreaks.delete(device.id)
    return
  }

  const previous = safeReturnStreaks.get(device.id)

  // Laporan yang nyaris bersamaan (heartbeat dobel/reconnect) bukan bukti
  // baru -- jangan dihitung, tapi jangan merusak streak yang sudah ada.
  if (previous && now - previous.lastAt < MIN_SAFE_STREAK_GAP_MS) return

  const count =
    previous && now - previous.lastAt <= MAX_SAFE_STREAK_GAP_MS ? previous.count + 1 : 1
  safeReturnStreaks.set(device.id, { count, lastAt: now })

  if (count < UNLOCK_SAFE_STREAK_REQUIRED) return

  safeReturnStreaks.delete(device.id)
  await autoUnlockIfSafeToReturn(device)
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

  // Selama device terus melanggar, heartbeat ~30 detik membuat pelanggaran
  // baru terus-menerus -- kalau semua dikirim ke Telegram, chat dibanjiri
  // ratusan pesan per jam. Log di violation_logs TETAP dicatat setiap kali
  // (dipakai logika konfirmasi 2x pelanggaran untuk auto-lock), cuma
  // notifikasinya yang di-throttle.
  const recentlyNotified = await ViolationLog.query()
    .where('device_id', device.id)
    .where('geofence_rule_id', rule.id)
    .where('violation_type', type)
    .where('notified_telegram', true)
    .where('detected_at', '>=', new Date(Date.now() - TELEGRAM_NOTIFY_MIN_INTERVAL_MS))
    .orderBy('detected_at', 'desc')
    .first()

  const notifiedTelegram = recentlyNotified
    ? false
    : await notifyTelegramViolation(device.organizationId, telegramText)

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
  // Baca ulang status TERKINI dari DB dulu: caller bisa memegang objek device
  // yang sudah basi (mis. laporan kedua datang saat laporan pertama sedang
  // berjalan, masih membawa status 'online' hasil query sendiri) -- dulu ini
  // bisa membuat dua perintah lock kembar untuk satu kejadian (command
  // dobel yang sempat teramati di produksi).
  const fresh = await Device.query().select('status').where('id', device.id).first()
  if (!fresh || fresh.status === 'locked') return

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
  // Sama seperti autoLock: jangan percaya objek device milik caller (bisa
  // basi) -- kunci apakah device benar-benar masih terkunci SEKARANG.
  const fresh = await Device.query().select('status').where('id', device.id).first()
  if (fresh?.status !== 'locked') return

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
