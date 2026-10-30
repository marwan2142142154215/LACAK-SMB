import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import app from '@adonisjs/core/services/app'
import log from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import { disk, documentsDiskName } from '#services/storage'

/**
 * Build APK on-demand per site -- padanan App\Services\ApkBuilder di
 * backend-api. Skrip build_only.sh proyek Android dijalankan:
 * - di server Linux: langsung dengan `bash` (runner 'bash'),
 * - di Windows: lewat WSL2 (`wsl --exec`, runner 'wsl') -- Gradle tidak bisa
 *   jalan di Windows native di mesin build.
 * Runner dipilih otomatis dari OS, bisa dipaksa dengan LACAKSMB_APK_BUILD_RUNNER. Dipanggil
 * dari app/jobs/build_apk_job.ts (antrean BullMQ), bukan dari controller,
 * supaya request HTTP dashboard/APK master tidak menunggu 30-90 detik build.
 *
 * Perintah, argumen, path, dan isi build_log SAMA dengan versi Laravel --
 * skrip build di proyek Android tidak perlu diubah.
 */

export type ApkType = 'tracker' | 'master' | 'live' | 'server'

export const APK_TYPES: readonly ApkType[] = ['tracker', 'master', 'live', 'server']

/** Process::timeout(300) di backend-api. */
export const BUILD_TIMEOUT_SECONDS = 300

/** mb_substr($output, -5000): build_log hanya menyimpan ekor output. */
export const BUILD_LOG_TAIL = 5000

export type ApkBuildRunner = 'bash' | 'wsl'

export type ApkBuilderConfig = {
    runner: ApkBuildRunner
    trackerProjectPath: string
    masterProjectPath: string
    liveProjectPath: string
    serverExePath: string
    wslDistro: string
    publicGatewayUrl: string
    publicBackendApiUrl: string
}

/**
 * config/lacaksmb.php backend-api. Bawaannya relatif terhadap folder
 * backend-adonis (setara base_path('..') di Laravel); di server sebaiknya
 * LACAKSMB_*_PROJECT_PATH diisi eksplisit.
 */
export function apkBuilderConfig(): ApkBuilderConfig {
    return {
        runner:
            env.get('LACAKSMB_APK_BUILD_RUNNER') ?? (process.platform === 'win32' ? 'wsl' : 'bash'),
        trackerProjectPath:
            env.get('LACAKSMB_TRACKER_PROJECT_PATH') ?? app.makePath('..', 'android-tracked-app'),
        masterProjectPath:
            env.get('LACAKSMB_MASTER_PROJECT_PATH') ?? app.makePath('..', 'android-master-app'),
        liveProjectPath:
            env.get('LACAKSMB_LIVE_PROJECT_PATH') ?? app.makePath('..', 'android-live-app'),
        serverExePath:
            env.get('LACAKSMB_SERVER_EXE_PATH') ?? app.makePath('..', 'lacak-server.exe'),
        wslDistro: env.get('LACAKSMB_WSL_DISTRO') ?? 'Ubuntu',
        publicGatewayUrl: env.get('LACAKSMB_PUBLIC_GATEWAY_URL') ?? 'https://ws.salahmu.fun',
        publicBackendApiUrl:
            env.get('LACAKSMB_PUBLIC_BACKEND_API_URL') ?? 'https://api.salahmu.fun/api/v1',
    }
}

/** "C:\Users\X\lacak\foo" -> "/mnt/c/Users/X/lacak/foo" (konvensi WSL2). */
export function toWslPath(windowsPath: string): string {
    const normalized = windowsPath.replace(/\\/g, '/')
    const matches = normalized.match(/^([A-Za-z]):\/(.*)$/s)
    if (!matches) {
        throw new Error(`Path Windows tidak valid: ${windowsPath}`)
    }
    return `/mnt/${matches[1].toLowerCase()}/${matches[2]}`
}

/** rtrim($path, '/\\') di backend-api. */
export function trimTrailingSlashes(path: string): string {
    return path.replace(/[/\\]+$/, '')
}

export function projectPathFor(apkType: string, config: ApkBuilderConfig): string {
    if (apkType === 'master') return config.masterProjectPath
    if (apkType === 'live') return config.liveProjectPath
    return config.trackerProjectPath
}

/**
 * APK master bersifat UNIVERSAL -- bukan milik salah satu site. Akses ke site
 * ditentukan oleh akun yang login (role + site_access), bukan dari kode site
 * yang ditanam saat build. Karena itu kode/nama site generik dipakai biar
 * build tetap bisa lewat skrip yang sama. APK Live sama: siaran selalu ke
 * site akun staf yang login.
 */
export function siteIdentityFor(
    apkType: string,
    organization: { unique_site_code: string; name: string }
): [siteCode: string, siteName: string] {
    if (apkType === 'master') return ['MASTER-UNIVERSAL', 'Lacak SMB']
    if (apkType === 'live') return ['LIVE-UNIVERSAL', 'Lacak SMB']
    return [organization.unique_site_code, organization.name]
}

/** Path skrip build sesuai runner: apa adanya (bash) atau /mnt/c/... (WSL). */
export function buildScriptPath(projectPath: string, config: ApkBuilderConfig): string {
    const script = `${projectPath}/scripts/build_only.sh`
    return config.runner === 'wsl' ? toWslPath(script) : script
}

/**
 * Argumen selalu diteruskan sebagai array -- tanpa shell di sisi Node (spawn)
 * maupun di WSL (`--exec`, bukan `--`), jadi `$(...)`/backtick di nama site
 * atau versi tidak bisa dieksekusi sebagai perintah.
 */
export function buildCommand(options: {
    config: ApkBuilderConfig
    scriptPath: string
    siteCode: string
    siteName: string
    version: string
    deviceUuid: string | null
    deviceSecret: string | null
}): string[] {
    const { config } = options
    const runner =
        config.runner === 'wsl' ? ['wsl', '-d', config.wslDistro, '--exec', 'bash'] : ['bash']
    return [
        ...runner,
        options.scriptPath,
        options.siteCode,
        config.publicGatewayUrl,
        options.siteName,
        options.version,
        config.publicBackendApiUrl,
        // Identitas zero-touch (lihat ApkBuildsController.generate) -- cuma
        // terisi untuk apk_type='tracker'.
        options.deviceUuid ?? '',
        options.deviceSecret ?? '',
    ]
}

/** mb_substr($text, -n): n karakter (code point) terakhir. */
export function tail(text: string, length: number = BUILD_LOG_TAIL): string {
    const chars = Array.from(text)
    return chars.length <= length ? text : chars.slice(-length).join('')
}

export type ProcessResult = { exitCode: number | null; output: string; errorOutput: string }

/** Kesalahan yang dilempar saat proses build melewati batas waktu (ProcessTimedOutException). */
export class ProcessTimedOutError extends Error {}

/**
 * Padanan Process::timeout()->run() Laravel: stdout & stderr dikumpulkan
 * terpisah; lewat batas waktu -> proses dimatikan dan error dilempar (job
 * lalu ditandai gagal, sama seperti BuildApkJob::failed()).
 */
export function runProcess(
    command: string[],
    timeoutSeconds: number = BUILD_TIMEOUT_SECONDS
): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        const [executable, ...args] = command
        const child = spawn(executable, args, { shell: false, windowsHide: true })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let timedOut = false

        const timer = setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
        }, timeoutSeconds * 1000)

        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', (error) => {
            clearTimeout(timer)
            reject(error)
        })
        child.on('close', (exitCode) => {
            clearTimeout(timer)
            if (timedOut) {
                reject(
                    new ProcessTimedOutError(
                        `The process "${command.map(quoteArgument).join(' ')}" exceeded the timeout of ${timeoutSeconds} seconds.`
                    )
                )
                return
            }
            resolve({
                exitCode,
                output: Buffer.concat(stdout).toString('utf8'),
                errorOutput: Buffer.concat(stderr).toString('utf8'),
            })
        })
    })
}

function quoteArgument(argument: string): string {
    return /^[\w./:=@-]+$/.test(argument) ? argument : `"${argument.replace(/"/g, '\\"')}"`
}

/** hash_file('sha256', $path). */
export function sha256File(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256')
        createReadStream(path)
            .on('data', (chunk) => hash.update(chunk))
            .on('error', reject)
            .on('end', () => resolve(hash.digest('hex')))
    })
}

async function isFile(path: string): Promise<boolean> {
    try {
        const info = await stat(path)
        return info.isFile()
    } catch {
        return false
    }
}

/** Tipe MIME yang dipakai Flysystem (deteksi dari ekstensi) saat menyimpan artefak. */
const ARTIFACT_CONTENT_TYPES: Record<string, string> = {
    apk: 'application/vnd.android.package-archive',
    exe: 'application/x-msdownload',
}

export type ApkBuildRow = {
    id: number
    organization_id: number
    device_id: number | null
    apk_type: string
    version: string
}

async function updateBuild(id: number, values: Record<string, unknown>) {
    await db
        .from('apk_builds')
        .where('id', id)
        .update({ ...values, updated_at: new Date() })
}

/**
 * @param deviceSecret Rahasia device asli untuk APK tracker zero-touch;
 *                     database hanya menyimpan hash-nya.
 */
export async function buildApk(
    apkBuild: ApkBuildRow,
    deviceSecret: string | null = null,
    config: ApkBuilderConfig = apkBuilderConfig()
): Promise<void> {
    // Organization::findOrFail -- site yang di-soft-delete dianggap tidak ada.
    const organization = await db
        .from('organizations')
        .where('id', apkBuild.organization_id)
        .whereNull('deleted_at')
        .select('id', 'name', 'unique_site_code')
        .first()
    if (!organization) {
        throw new Error(
            `No query results for model [App\\Models\\Organization] ${apkBuild.organization_id}`
        )
    }

    const documentsDisk = disk(documentsDiskName())

    // Tipe 'server' tidak lewat Gradle -- langsung menyalin lacak-server.exe
    // yang sudah jadi (bangunan server-gui).
    if (apkBuild.apk_type === 'server') {
        const exePathWindows = config.serverExePath

        if (!(await isFile(exePathWindows))) {
            await updateBuild(apkBuild.id, {
                status: 'failed',
                build_log: `lacak-server.exe tidak ditemukan di: ${exePathWindows}\nBangun dulu dengan: python -m PyInstaller --onefile server-gui/lacak_server.py`,
            })
            return
        }

        const checksum = await sha256File(exePathWindows)
        const storedPath = `apk-builds/${organization.id}/server-${apkBuild.id}.exe`
        await documentsDisk.put(
            storedPath,
            await readFile(exePathWindows),
            ARTIFACT_CONTENT_TYPES.exe
        )

        await updateBuild(apkBuild.id, {
            status: 'success',
            file_path: storedPath,
            embedded_site_code: organization.unique_site_code,
            checksum_sha256: checksum,
            build_log: `Server controller disalin sebagai artefak (tanpa build Gradle).\nSumber: ${exePathWindows}`,
        })
        return
    }

    const projectPath = trimTrailingSlashes(projectPathFor(apkBuild.apk_type, config))
    const scriptPath = buildScriptPath(projectPath, config)
    const [siteCode, siteName] = siteIdentityFor(apkBuild.apk_type, organization)

    // $apkBuild->device?->device_uuid -- relasi Eloquent mengabaikan device
    // yang sudah di-soft-delete.
    const device = apkBuild.device_id
        ? await db
              .from('devices')
              .where('id', apkBuild.device_id)
              .whereNull('deleted_at')
              .select('device_uuid')
              .first()
        : null

    const result = await runProcess(
        buildCommand({
            config,
            scriptPath,
            siteCode,
            siteName,
            version: apkBuild.version,
            deviceUuid: device?.device_uuid ?? null,
            deviceSecret,
        })
    )

    const output = result.output + result.errorOutput

    if (result.exitCode !== 0) {
        await updateBuild(apkBuild.id, { status: 'failed', build_log: tail(output) })
        log.warn({ apk_build_id: apkBuild.id, exit_code: result.exitCode }, 'Build APK gagal')
        return
    }

    if (!output.includes('APK_PATH=')) {
        await updateBuild(apkBuild.id, {
            status: 'failed',
            build_log: `${tail(output)}\n\n(Tidak menemukan baris APK_PATH di output build)`,
        })
        return
    }

    // SENGAJA tidak memakai path dari baris APK_PATH= apa adanya -- dengan
    // runner WSL itu path /mnt/c/..., padahal proses Node ini jalan di Windows
    // native. Dihitung ulang dari path proyek (berlaku untuk kedua runner).
    const apkPathWindows = `${projectPath}/app/build/outputs/apk/debug/app-debug.apk`

    if (!(await isFile(apkPathWindows))) {
        await updateBuild(apkBuild.id, {
            status: 'failed',
            build_log: `File APK hasil build tidak ditemukan di: ${apkPathWindows}`,
        })
        return
    }

    const checksum = await sha256File(apkPathWindows)
    const storedPath = `apk-builds/${organization.id}/${apkBuild.apk_type}-${apkBuild.id}.apk`
    await documentsDisk.put(storedPath, await readFile(apkPathWindows), ARTIFACT_CONTENT_TYPES.apk)

    await updateBuild(apkBuild.id, {
        status: 'success',
        file_path: storedPath,
        embedded_site_code: siteCode,
        checksum_sha256: checksum,
        build_log: tail(output),
    })
}
