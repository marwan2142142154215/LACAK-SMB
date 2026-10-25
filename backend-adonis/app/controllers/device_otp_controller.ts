import { randomInt } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import { accessOf, can } from '#services/access'
import { fail, success } from '#services/api_response'
import { laravelDate } from '#services/activity_log'
import { hashLaravelPassword, verifyLaravelPassword } from '#services/laravel/bcrypt'
import { authorizedOrganizationId } from '#services/organization_scope'
import {
    eloquentNow,
    findDeviceOrFail,
    logDeviceUpdated,
    updateDevice,
    type DeviceRow,
} from '#services/device_resource'
import { verifyDeviceOtpValidator } from '#validators/devices'

/** Maksimum tebakan OTP salah per device sebelum diblokir sementara. */
export const MAX_OTP_ATTEMPTS = 5

/** Lama jendela hitungan percobaan OTP (menit); mengikuti masa berlaku OTP. */
const OTP_ATTEMPT_WINDOW_MINUTES = 5

/** Masa berlaku OTP (DeviceOtp::generateFor, $validMinutes = 5). */
const OTP_VALID_MINUTES = 5

/** OTP 6 digit acak (random_int(100000, 999999) di Laravel). */
export function generateOtpCode(): string {
    return String(randomInt(100000, 1_000_000))
}

/**
 * OTP per-device untuk buka mandiri saat HP kena mode lock. Generate OTP
 * butuh login admin (operator), tapi verifikasi OTP dipanggil langsung oleh
 * APK pelacak di device target yang sedang terkunci — makanya endpoint
 * verify TIDAK pakai token login (device tidak bisa login saat terkunci),
 * cukup diamankan lewat device_uuid + kode OTP + rate limit (start/routes/devices.ts).
 *
 * Kode disimpan sebagai hash bcrypt $2y$ (Hash::make) supaya OTP buatan satu
 * backend tetap bisa diverifikasi backend lainnya selama masa transisi.
 */
export default class DeviceOtpController {
    async generate(ctx: HttpContext) {
        const device = await findDeviceOrFail(ctx.params.device)
        const access = await accessOf(ctx)
        if (!can(access, 'devices.unlock')) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melakukan tindakan ini'))
        }

        if (authorizedOrganizationId(access, device.organization_id) === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang membuat OTP untuk device ini'))
        }

        const plainCode = generateOtpCode()
        const now = eloquentNow()
        const expiresAt = new Date(now.getTime() + OTP_VALID_MINUTES * 60_000)
        const [{ id }] = await db
            .table('device_otps')
            .insert({
                device_id: device.id,
                otp_code_hash: await hashLaravelPassword(plainCode),
                purpose: 'self_unlock',
                expires_at: expiresAt,
                created_at: now,
                updated_at: now,
            })
            .returning(['id'])

        return ctx.response.status(201).send(
            success('OTP berhasil dibuat, berlaku 5 menit', {
                otp_id: Number(id),
                code: plainCode,
                expires_at: laravelDate(expiresAt),
            })
        )
    }

    async verify(ctx: HttpContext) {
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
            return ctx.response.status(404).send(fail('Device tidak dikenali'))
        }

        // Batas percobaan per device (selain throttle per-IP di route): OTP
        // cuma 6 digit, jadi tanpa ini ribuan tebakan bisa dilakukan selama
        // OTP berlaku. Setelah batas tercapai, minta OTP baru dari admin.
        const attemptsKey = `device_otp_attempts:${device.id}`
        const attempts = Number(await redis.get(attemptsKey)) || 0

        if (attempts >= MAX_OTP_ATTEMPTS) {
            return ctx.response
                .status(429)
                .send(fail('Terlalu banyak percobaan OTP. Minta admin membuat OTP baru.'))
        }

        const otp = await db
            .from('device_otps')
            .where('device_id', device.id)
            .where('purpose', 'self_unlock')
            .whereNull('used_at')
            .orderBy('id', 'desc')
            .first()

        const valid =
            otp !== null &&
            otp.used_at === null &&
            new Date(otp.expires_at).getTime() > Date.now() &&
            (await verifyLaravelPassword(String(data.code), otp.otp_code_hash))

        if (!valid) {
            // Cache::put(): jendela 5 menit dihitung ulang dari tebakan salah terakhir.
            await redis.set(
                attemptsKey,
                String(attempts + 1),
                'EX',
                OTP_ATTEMPT_WINDOW_MINUTES * 60
            )
            return ctx.response.status(422).send(fail('Kode OTP salah atau sudah kedaluwarsa'))
        }

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

        await redis.del(attemptsKey)

        return success('OTP benar, device dibuka')
    }
}
