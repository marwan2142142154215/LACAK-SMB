import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, statfs } from 'node:fs/promises'
import { hostname, loadavg } from 'node:os'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import env from '#start/env'
import { appQueue } from '#services/queue'

/**
 * Pemeriksaan kesehatan semua layanan Lacak SMB untuk halaman "Status
 * server" (super_admin) -- padanan app/Services/ServerStatus.php. Tiap
 * layanan dicek dengan cara yang benar-benar membuktikan ia bekerja, bukan
 * sekadar prosesnya hidup: database & cache = query/tulis-baca nyata,
 * scheduler & antrean = detak yang ditulis tiap menit oleh scheduler dan
 * oleh queue worker, gateway & LiveKit = permintaan HTTP ke layanannya.
 */

export const OK = 'ok'
export const WARN = 'warn'
export const DOWN = 'down'
export const UNKNOWN = 'unknown'

export type Status = typeof OK | typeof WARN | typeof DOWN | typeof UNKNOWN

/**
 * Kunci Redis berisi waktu ISO detak terakhir. Ditulis oleh scheduler &
 * queue worker Adonis (modul apk); dibaca di sini.
 */
export const SCHEDULER_HEARTBEAT_KEY = 'server-status:scheduler-heartbeat'
export const QUEUE_HEARTBEAT_KEY = 'server-status:queue-heartbeat'

/** Detak ditulis tiap menit -- lewat dari ini dianggap terlambat / mati. */
const HEARTBEAT_WARN_SECONDS = 150
const HEARTBEAT_DOWN_SECONDS = 600

const HTTP_TIMEOUT_SECONDS = 3

export type Service = {
    key: string
    name: string
    status: Status
    detail: string
    latency_ms: number | null
    last_seen_at: string | null
}

export type Unit = { name: string; state: string; status: Status }

export async function snapshot() {
    const [api, database, cache, scheduler, queue, http, storage, units, system] =
        await Promise.all([
            apiService(),
            databaseService(),
            cacheService(),
            schedulerService(),
            queueService(),
            httpServices(),
            storageService(),
            systemdUnits(),
            systemInfo(),
        ])
    const services = [api, database, cache, scheduler, queue, ...http, storage]

    return {
        checked_at: iso8601(new Date()),
        overall: overallStatus(services.map((entry) => entry.status)),
        services,
        units,
        system,
    }
}

/** DOWN kalau ada yang mati, WARN kalau ada yang terlambat; UNKNOWN tidak dihitung. */
export function overallStatus(statuses: Status[]): Status {
    if (statuses.includes(DOWN)) return DOWN
    if (statuses.includes(WARN)) return WARN
    return OK
}

function apiService(): Service {
    const adonis = app.adonisVersion?.toString()
    return service(
        'api',
        'API backend',
        OK,
        `Node ${process.versions.node}${adonis ? ` · AdonisJS ${adonis}` : ''}`,
        0
    )
}

async function databaseService(): Promise<Service> {
    const started = performance.now()
    try {
        const result = await db.rawQuery('show server_version')
        const version = String(result.rows[0]?.server_version ?? '').split(' ')[0]
        await db.rawQuery('select 1')

        return service('database', 'Database', OK, `PostgreSQL ${version}`, elapsed(started))
    } catch {
        return service(
            'database',
            'Database',
            DOWN,
            'Tidak bisa terhubung ke database',
            elapsed(started)
        )
    }
}

async function cacheService(): Promise<Service> {
    const started = performance.now()
    try {
        const token = randomBytes(4).toString('hex')
        await redis.setex('server-status:probe', 30, token)
        const ok = (await redis.get('server-status:probe')) === token

        return service('cache', 'Cache', ok ? OK : DOWN, 'Driver redis', elapsed(started))
    } catch {
        return service('cache', 'Cache', DOWN, 'Cache tidak bisa ditulis/dibaca', elapsed(started))
    }
}

async function schedulerService(): Promise<Service> {
    const lastSeen = await readHeartbeat(SCHEDULER_HEARTBEAT_KEY)
    const status = heartbeatStatus(lastSeen)

    return service(
        'scheduler',
        'Scheduler (tugas tiap menit)',
        status,
        status === OK
            ? 'Berjalan — menutup sesi Live Kerja yang terputus'
            : status === UNKNOWN
              ? 'Belum pernah berjalan. Pastikan layanan lacak-scheduler aktif.'
              : 'Terlambat — sesi Live Kerja yang putus tidak ditutup otomatis',
        null,
        lastSeen
    )
}

async function queueService(): Promise<Service> {
    const lastSeen = await readHeartbeat(QUEUE_HEARTBEAT_KEY)
    let pending: number | null = null
    let failed: number | null = null
    try {
        // Antrean BullMQ milik Adonis + sisa tabel antrean database Laravel
        // (QUEUE_CONNECTION=database) -- selama masa transisi job lama di
        // tabel jobs masih diproses worker Laravel, jadi keduanya dijumlah.
        const [jobs, failedJobs, bull] = await Promise.all([
            db.from('jobs').count('* as total').first(),
            db.from('failed_jobs').count('* as total').first(),
            appQueue().getJobCounts('wait', 'delayed', 'prioritized', 'failed'),
        ])
        pending =
            Number(jobs?.total ?? 0) +
            (bull.wait ?? 0) +
            (bull.delayed ?? 0) +
            (bull.prioritized ?? 0)
        failed = Number(failedJobs?.total ?? 0) + (bull.failed ?? 0)
    } catch {
        pending = failed = null
    }
    // Worker memproses satu job sekali jalan; build APK bisa makan
    // beberapa menit dan menunda detaknya -- itu bukan worker mati.
    const building = Boolean(
        await db.from('apk_builds').where('status', 'building').select('id').first()
    )

    return service(
        'queue',
        'Antrean (queue worker)',
        ...queueVerdict(heartbeatStatus(lastSeen), building, pending, failed),
        null,
        lastSeen
    )
}

/** Status & kalimat antrean, sama dengan ServerStatus::queue(). */
export function queueVerdict(
    heartbeat: Status,
    building: boolean,
    pending: number | null,
    failed: number | null
): [Status, string] {
    const status = heartbeat !== OK && building ? WARN : heartbeat

    let detail: string
    if (status === UNKNOWN) {
        detail =
            'Belum ada job yang diproses. Pastikan layanan lacak-queue dan lacak-scheduler aktif.'
    } else if (status !== OK && building) {
        detail = 'Sedang memproses build APK — job lain menunggu'
    } else if (status === OK) {
        detail = 'Worker memproses job'
    } else {
        detail = 'Worker tidak memproses job — build APK tidak akan jalan'
    }
    if (pending !== null) {
        detail += ` · ${pending} menunggu · ${failed} gagal`
    }

    return [status, detail]
}

/**
 * Gateway realtime (chat, device, radar) & LiveKit (siaran) dicek
 * bersamaan supaya halaman tidak menunggu dua kali timeout.
 */
async function httpServices(): Promise<Service[]> {
    const targets: Array<[string, string, string | null]> = [
        ['gateway', 'Gateway realtime (chat, device, radar)', gatewayStatusUrl()],
        ['livekit', 'LiveKit (siaran Live Kerja)', livekitStatusUrl()],
    ]

    return Promise.all(
        targets.map(async ([key, name, url]) => {
            if (!url) {
                return service(key, name, UNKNOWN, 'Alamat pemeriksaan belum diatur', null)
            }
            const started = performance.now()
            let response: Response
            try {
                response = await fetch(url, {
                    signal: AbortSignal.timeout(HTTP_TIMEOUT_SECONDS * 1000),
                })
            } catch {
                return service(
                    key,
                    name,
                    DOWN,
                    `Tidak menjawab dalam ${HTTP_TIMEOUT_SECONDS} detik`,
                    null
                )
            }
            let body: unknown = null
            if (key === 'gateway') {
                body = await response.json().catch(() => null)
            } else {
                await response.body?.cancel().catch(() => {})
            }
            const latency = elapsed(started)
            const ok = probeOk(key, response.status, body)

            return service(
                key,
                name,
                ok ? OK : DOWN,
                ok ? 'Menjawab normal' : `Menjawab dengan error HTTP ${response.status}`,
                latency
            )
        })
    )
}

/** 2xx; gateway juga wajib menjawab data.status === 'ok'. */
export function probeOk(key: string, status: number, body: unknown): boolean {
    if (status < 200 || status >= 300) return false
    if (key !== 'gateway') return true
    return (body as { data?: { status?: unknown } } | null)?.data?.status === 'ok'
}

/** lacaksmb.status.gateway_url: status URL, lalu URL publik gateway, lalu bawaan. */
function gatewayStatusUrl(): string | null {
    return (
        env.get('LACAKSMB_STATUS_GATEWAY_URL') ||
        env.get('LACAKSMB_PUBLIC_GATEWAY_URL') ||
        'https://ws.salahmu.fun'
    )
}

/** LiveKit kosong = diturunkan dari LIVEKIT_URL (ws -> http). */
function livekitStatusUrl(): string | null {
    return env.get('LACAKSMB_STATUS_LIVEKIT_URL') || livekitHttpUrl(env.get('LIVEKIT_URL'))
}

export function livekitHttpUrl(url: string | null | undefined): string | null {
    return url ? url.replace(/^ws(s?):\/\//, 'http$1://') : null
}

async function storageService(): Promise<Service> {
    let total = 0
    let free = 0
    try {
        const info = await statfs(app.makePath())
        total = info.blocks * info.bsize
        free = info.bavail * info.bsize
    } catch {
        total = 0
    }
    if (!total) {
        return service('storage', 'Penyimpanan disk', UNKNOWN, 'Ukuran disk tidak terbaca', null)
    }

    const [status, detail] = storageVerdict(free, total)
    return service('storage', 'Penyimpanan disk', status, detail, null)
}

export function storageVerdict(free: number, total: number): [Status, string] {
    const freeRatio = free / total
    const status = freeRatio < 0.03 ? DOWN : freeRatio < 0.1 ? WARN : OK

    return [
        status,
        `Sisa ${formatBytes(free)} dari ${formatBytes(total)} (${Math.round(freeRatio * 100)}%)`,
    ]
}

/**
 * Status unit systemd di server Linux (lacak-gateway, lacak-queue, ...).
 * Daftar unit dari env, bukan dari input -- aman dijalankan.
 */
async function systemdUnits(): Promise<Unit[]> {
    const units = parseUnits(
        env.get(
            'LACAKSMB_STATUS_SYSTEMD_UNITS',
            'lacak-gateway,lacak-queue,lacak-scheduler,lacak-bot,php8.3-fpm'
        )
    )
    if (!units.length || process.platform !== 'linux') {
        return []
    }

    // `systemctl is-active` keluar dengan kode bukan 0 kalau ada unit yang
    // tidak aktif -- keluarannya tetap dipakai (seperti Process::run()).
    const output = await new Promise<string>((resolve) => {
        execFile('systemctl', ['is-active', ...units], { timeout: 5000 }, (_error, stdout) =>
            resolve(String(stdout ?? ''))
        )
    })

    return unitStatuses(units, output)
}

export function parseUnits(value: string | undefined | null): string[] {
    return String(value ?? '')
        .split(',')
        .map((unit) => unit.trim())
        .filter(Boolean)
}

export function unitStatuses(units: string[], output: string): Unit[] {
    const trimmed = output.trim()
    const states = trimmed === '' ? [] : trimmed.split(/\r\n|\n|\r/)

    return units.map((name, index) => {
        const state = states[index] || 'unknown'
        return { name, state, status: unitStatus(state) }
    })
}

function unitStatus(state: string): Status {
    if (state === 'active') return OK
    if (['activating', 'reloading', 'deactivating'].includes(state)) return WARN
    if (['inactive', 'failed'].includes(state)) return DOWN
    return UNKNOWN
}

async function systemInfo() {
    let memory: { total: number; used: number } | null = null
    let uptime: number | null = null
    let cpuCount: number | null = null

    const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => null)
    if (meminfo !== null) {
        const total = meminfo.match(/^MemTotal:\s+(\d+) kB/m)
        const available = meminfo.match(/^MemAvailable:\s+(\d+) kB/m)
        if (total && available) {
            const totalBytes = Number(total[1]) * 1024
            memory = { total: totalBytes, used: totalBytes - Number(available[1]) * 1024 }
        }
    }
    const uptimeText = await readFile('/proc/uptime', 'utf8').catch(() => null)
    if (uptimeText !== null) {
        uptime = Number.parseInt(uptimeText.split(' ')[0], 10)
    }
    const cpuinfo = await readFile('/proc/cpuinfo', 'utf8').catch(() => null)
    if (cpuinfo !== null) {
        cpuCount = cpuinfo.match(/^processor\s*:/gm)?.length || null
    }

    return {
        hostname: hostname() || null,
        os: osFamily(process.platform),
        environment: laravelEnvironment(app.nodeEnvironment),
        timezone: process.env.TZ || 'UTC',
        // sys_getloadavg() tidak ada di Windows -> null, sama dengan PHP.
        load: process.platform === 'win32' ? null : loadavg(),
        cpu_count: cpuCount,
        memory,
        uptime_seconds: uptime,
    }
}

/** PHP_OS_FAMILY. */
export function osFamily(platform: string): string {
    switch (platform) {
        case 'linux':
            return 'Linux'
        case 'win32':
            return 'Windows'
        case 'darwin':
            return 'Darwin'
        case 'freebsd':
        case 'openbsd':
        case 'netbsd':
            return 'BSD'
        case 'sunos':
            return 'Solaris'
        default:
            return 'Unknown'
    }
}

/** app()->environment() memakai nama Laravel: production / local / testing. */
function laravelEnvironment(nodeEnvironment: string): string {
    if (nodeEnvironment === 'development') return 'local'
    if (nodeEnvironment === 'test') return 'testing'
    return nodeEnvironment
}

async function readHeartbeat(key: string): Promise<string | null> {
    try {
        return (await redis.get(key)) || null
    } catch {
        return null
    }
}

export function heartbeatStatus(lastSeen: string | null, now: Date = new Date()): Status {
    if (!lastSeen) return UNKNOWN
    const seenAt = Date.parse(lastSeen)
    if (Number.isNaN(seenAt)) return UNKNOWN
    const age = Math.abs(now.getTime() - seenAt) / 1000

    if (age <= HEARTBEAT_WARN_SECONDS) return OK
    if (age <= HEARTBEAT_DOWN_SECONDS) return WARN
    return DOWN
}

function service(
    key: string,
    name: string,
    status: Status,
    detail: string,
    latencyMs: number | null,
    lastSeen: string | null = null
): Service {
    return { key, name, status, detail, latency_ms: latencyMs, last_seen_at: lastSeen }
}

function elapsed(started: number): number {
    return Math.round(performance.now() - started)
}

/** Seperti ServerStatus::bytes(): "12.5 GB", "512 MB". */
export function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const power =
        bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0

    return `${Math.round((bytes / 1024 ** power) * 10) / 10} ${units[power]}`
}

/** Carbon toIso8601String() di zona UTC: 2026-10-25T03:45:45+00:00. */
export function iso8601(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, '+00:00')
}
