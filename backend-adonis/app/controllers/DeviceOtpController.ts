import { randomInt } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import { accessOf, can } from '#services/Access'
import { fail, success } from '#services/ApiResponse'
import { laravelDate, writeActivity } from '#services/ActivityLog'
import { hashLaravelPassword, verifyLaravelPassword } from '#services/laravel/Bcrypt'
import { canAccessOrganization } from '#services/OrganizationScope'
import {
    DEVICE_MORPH,
    eloquentNow,
    findDeviceOrFail,
    logDeviceUpdated,
    updateDevice,
    type DeviceRow,
} from '#services/DeviceResource'
import { generateDeviceOtpValidator, verifyDeviceOtpValidator } from '#validators/Devices'

/** Maksimum tebakan OTP salah per device sebelum diblokir sementara. */
export const MAX_OTP_ATTEMPTS = 5

/** Lama jendela hitungan percobaan OTP (menit); mengikuti masa berlaku OTP. */
const OTP_ATTEMPT_WINDOW_MINUTES = 5

/** Masa berlaku OTP buka kunci (DeviceOtp::generateFor, $validMinutes = 5). */
const OTP_VALID_MINUTES = 5

/**
 * Masa berlaku kode lepas perangkat: lebih lama karena staf lapangan perlu waktu memasukkannya di
 * HP target (bukan sekadar membuka kunci yang tinggal diketik di depan admin).
 */
const RELEASE_VALID_MINUTES = 15

type OtpPurpose = 'self_unlock' | 'release'

/** Jenis OTP -> izin admin, masa berlaku, dan pesan kesalahan (teks self_unlock dijaga tetap sama). */
const PURPOSE_CONFIG: Record<
    OtpPurpose,
    { permission: string; validMinutes: number; invalidMessage: string; tooManyMessage: string }
> = {
    self_unlock: {
        permission: 'devices.unlock',
        validMinutes: OTP_VALID_MINUTES,
        invalidMessage: 'Kode OTP salah atau sudah kedaluwarsa',
        tooManyMessage: 'Terlalu banyak percobaan OTP. Minta admin membuat OTP baru.',
    },
    release: {
        permission: 'devices.manage',
        validMinutes: RELEASE_VALID_MINUTES,
        invalidMessage: 'Kode salah atau sudah kedaluwarsa',
        tooManyMessage: 'Terlalu banyak percobaan kode. Minta admin membuat kode baru.',
    },
}

/** Kunci penghitung percobaan di Redis dipisah per jenis supaya tidak saling mengunci. */
function attemptsKeyFor(deviceId: number, purpose: OtpPurpose): string {
    return purpose === 'release'
        ? `device_release_attempts:${deviceId}`
        : `device_otp_attempts:${deviceId}`
}

/** OTP 6 digit acak (random_int(100000, 999999) di Laravel). */
export function generateOtpCode(): string {
    return String(randomInt(100000, 1_000_000))
}

/**
 * OTP per-device untuk DUA keperluan, masing-masing dibuat admin (butuh login) lalu dimasukkan di
 * HP target oleh staf lapangan:
 *  - self_unlock: membuka HP yang sedang kena mode lock (izin devices.unlock).
 *  - release: MELEPAS perangkat -- APK mencabut kunci lokasi & blokir uninstall lalu melepas Device
 *    Owner/Admin, sehingga aplikasi bisa dihapus (izin devices.manage).
 *
 * Endpoint verify/release TIDAK pakai token login: HP yang terkunci / akan dilepas tidak bisa login,
 * jadi cukup diamankan device_uuid + kode OTP + rate limit (start/routes/devices.ts). Kode disimpan
 * sebagai hash bcrypt $2y$ (Hash::make) supaya OTP buatan satu backend tetap bisa diverifikasi
 * backend lainnya selama masa transisi.
 */
export default class DeviceOtpController {
    async generate(ctx: HttpContext) {
        const { purpose = 'self_unlock' } = await ctx.request.validateUsing(
            generateDeviceOtpValidator,
            { messagesProvider: generateDeviceOtpValidator.messagesProvider }
        )
        const config = PURPOSE_CONFIG[purpose as OtpPurpose]

        const device = await findDeviceOrFail(ctx.params.device)
        const access = await accessOf(ctx)
        if (!can(access, config.permission)) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melakukan tindakan ini'))
        }

        if (!canAccessOrganization(access, device.organization_id)) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang membuat kode untuk device ini'))
        }

        const plainCode = generateOtpCode()
        const now = eloquentNow()
        const expiresAt = new Date(now.getTime() + config.validMinutes * 60_000)
        const [{ id }] = await db
            .table('device_otps')
            .insert({
                device_id: device.id,
                otp_code_hash: await hashLaravelPassword(plainCode),
                purpose,
                expires_at: expiresAt,
                created_at: now,
                updated_at: now,
            })
            .returning(['id'])

        if (purpose === 'release') {
            // Membuat jalan untuk melepas Device Owner & menghapus aplikasi -- dicatat untuk audit.
            await writeActivity(ctx, {
                logName: 'default',
                description: 'release_code_issued',
                event: 'release_code_issued',
                subjectType: DEVICE_MORPH,
                subjectId: device.id,
                properties: { purpose: 'release' },
                organizationId: device.organization_id,
            })
        }

        const message =
            purpose === 'release'
                ? `Kode lepas perangkat dibuat, berlaku ${config.validMinutes} menit`
                : `OTP berhasil dibuat, berlaku ${config.validMinutes} menit`

        return ctx.response.status(201).send(
            success(message, {
                otp_id: Number(id),
                code: plainCode,
                purpose,
                expires_at: laravelDate(expiresAt),
            })
        )
    }

    /** Buka kunci mandiri: HP yang sedang locked kembali 'online' setelah kode benar. */
    async verify(ctx: HttpContext) {
        const found = await this.consumeOtp(ctx, 'self_unlock')
        if (!found) return

        const { device, otp } = found
        const updated = await db.transaction(async (trx) => {
            const now = eloquentNow()
            await trx
                .from('device_otps')
                .where('id', otp.id)
                .update({ used_at: now, updated_at: now })
            return updateDevice(device, { status: 'online' }, trx)
        })
        // Dipanggil tanpa login: causer kosong, sama seperti di Laravel.
        await logDeviceUpdated(ctx, device, updated)
        await redis.del(attemptsKeyFor(device.id, 'self_unlock'))

        return success('OTP benar, device dibuka')
    }

    /**
     * Lepas perangkat: tandai device dilepas (is_active=false, released_at) supaya gateway tidak lagi
     * menerimanya. APK yang memanggil ini lalu mencabut kunci lokasi & blokir uninstall dan melepas
     * status Device Owner/Admin, sehingga aplikasi bisa dihapus dari HP.
     */
    async release(ctx: HttpContext) {
        const found = await this.consumeOtp(ctx, 'release')
        if (!found) return

        const { device, otp } = found
        const now = eloquentNow()
        await db.transaction(async (trx) => {
            await trx
                .from('device_otps')
                .where('id', otp.id)
                .update({ used_at: now, updated_at: now })
            await trx
                .from('devices')
                .where('id', device.id)
                .update({ is_active: false, released_at: now, updated_at: now })
        })
        // is_active berubah true->false: tercatat di activity_log lewat logDeviceUpdated.
        await logDeviceUpdated(ctx, device, { ...device, is_active: false, updated_at: now })
        await redis.del(attemptsKeyFor(device.id, 'release'))

        return success('Kode benar, perangkat dilepas. Aplikasi sekarang bisa dihapus dari HP.')
    }

    /**
     * Validasi body + rate limit + cari OTP aktif untuk purpose ini. Mengembalikan device + baris OTP
     * yang valid, atau null kalau sudah mengirim respons error (device tidak dikenal / terlalu banyak
     * percobaan / kode salah). Pemanggil yang menandai OTP terpakai di dalam transaksinya sendiri.
     */
    private async consumeOtp(
        ctx: HttpContext,
        purpose: OtpPurpose
    ): Promise<{ device: DeviceRow; otp: { id: number; otp_code_hash: string } } | null> {
        const data = await ctx.request.validateUsing(verifyDeviceOtpValidator, {
            // Pesan versi Laravel dari validator ini, walau ada provider global.
            messagesProvider: verifyDeviceOtpValidator.messagesProvider,
        })

        const device = (await db
            .from('devices')
            .where('device_uuid', data.device_uuid)
            .whereNull('deleted_at')
            .first()) as DeviceRow | null

        if (!device) {
            ctx.response.status(404).send(fail('Device tidak dikenali'))
            return null
        }

        // Batas percobaan per device (selain throttle per-IP di route): OTP cuma 6 digit, jadi tanpa
        // ini ribuan tebakan bisa dilakukan selama OTP berlaku. Setelah batas tercapai, minta kode baru.
        const attemptsKey = attemptsKeyFor(device.id, purpose)
        // INCR atomik sebelum verifikasi: permintaan paralel tidak bisa melewati batas percobaan.
        const attempts = await redis.incr(attemptsKey)
        await redis.expire(attemptsKey, OTP_ATTEMPT_WINDOW_MINUTES * 60)

        if (attempts > MAX_OTP_ATTEMPTS) {
            ctx.response.status(429).send(fail(PURPOSE_CONFIG[purpose].tooManyMessage))
            return null
        }

        const otp = await db
            .from('device_otps')
            .where('device_id', device.id)
            .where('purpose', purpose)
            .whereNull('used_at')
            .orderBy('id', 'desc')
            .first()

        const valid =
            otp !== null &&
            otp.used_at === null &&
            new Date(otp.expires_at).getTime() > Date.now() &&
            (await verifyLaravelPassword(String(data.code), otp.otp_code_hash))

        if (!valid) {
            ctx.response.status(422).send(fail(PURPOSE_CONFIG[purpose].invalidMessage))
            return null
        }

        return { device, otp }
    }
}
