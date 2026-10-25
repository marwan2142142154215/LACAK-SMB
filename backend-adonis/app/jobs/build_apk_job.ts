import type { Job } from 'bullmq'
import db from '@adonisjs/lucid/services/db'
import { laravelEncrypter } from '#services/laravel/index'
import { buildApk, type ApkBuildRow } from '#services/apk_builder'
import { dispatch, JOB_BUILD_APK } from '#services/queue'

/**
 * Padanan App\Jobs\BuildApkJob. Payload dienkripsi (ShouldBeEncrypted di
 * Laravel): untuk APK tracker zero-touch, payload membawa rahasia device
 * asli (server sendiri hanya menyimpan hash-nya), jadi tidak boleh tersimpan
 * polos di Redis.
 */
export type BuildApkPayload = {
    apkBuildId: number
    /** Rahasia device, terenkripsi dengan APP_KEY Laravel; null untuk master/live/server. */
    deviceSecret: string | null
}

export function encodeBuildApkPayload(
    apkBuildId: number,
    deviceSecret: string | null
): BuildApkPayload {
    return {
        apkBuildId,
        deviceSecret: deviceSecret === null ? null : laravelEncrypter.encryptString(deviceSecret),
    }
}

export function decodeDeviceSecret(payload: BuildApkPayload): string | null {
    return payload.deviceSecret === null
        ? null
        : laravelEncrypter.decryptString(payload.deviceSecret)
}

export async function dispatchBuildApk(apkBuildId: number, deviceSecret: string | null) {
    return dispatch(JOB_BUILD_APK, encodeBuildApkPayload(apkBuildId, deviceSecret))
}

/** Isi handle() + failed() BuildApkJob. */
export async function handleBuildApk(job: Job<BuildApkPayload>) {
    const { apkBuildId } = job.data

    try {
        const apkBuild: ApkBuildRow | null = await db
            .from('apk_builds')
            .where('id', apkBuildId)
            .select('id', 'organization_id', 'device_id', 'apk_type', 'version')
            .first()

        if (!apkBuild) {
            return
        }

        await db
            .from('apk_builds')
            .where('id', apkBuildId)
            .update({ status: 'building', updated_at: new Date() })

        await buildApk(apkBuild, decodeDeviceSecret(job.data))
    } catch (error) {
        await db
            .from('apk_builds')
            .where('id', apkBuildId)
            .update({
                status: 'failed',
                build_log: error instanceof Error ? error.message : String(error),
                updated_at: new Date(),
            })
        throw error
    }
}
