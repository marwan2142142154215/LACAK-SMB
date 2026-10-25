import { createHash, randomBytes } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { accessOf, can } from '#services/access'
import { fail, success } from '#services/api_response'
import { authorizedOrganizationId } from '#services/organization_scope'
import { eloquentNow, findDeviceOrFail, saveDevice } from '#services/device_resource'
import { claimDeviceValidator } from '#validators/devices'

/** 32 byte acak = 256 bit; cukup tinggi entropinya sehingga SHA-256 tanpa salt aman dipakai. */
const SECRET_BYTES = 32

/**
 * Rahasia device baru (hex) -- generatePlainSecret() di backend-api. Juga
 * dipakai untuk APK tracker zero-touch yang rahasianya ditanam saat build.
 */
export function generatePlainSecret(): string {
    return randomBytes(SECRET_BYTES).toString('hex')
}

/**
 * hash('sha256', $plain) Laravel: hex huruf kecil. WAJIB sama dengan yang
 * dicocokkan realtime-gateway (app/services/device_credentials.ts).
 */
export function hashDeviceSecret(plainSecret: string): string {
    return createHash('sha256').update(plainSecret, 'utf8').digest('hex')
}

/**
 * Penerbitan rahasia device untuk autentikasi ke realtime-gateway, padanan
 * DeviceEnrollmentController di backend-api.
 *
 * Admin mendaftarkan device memakai device_uuid yang tampil di layar APK
 * pelacak — nilai itu TIDAK rahasia. APK lalu "mengklaim" pendaftarannya
 * lewat claim(): server membuat token acak, menyimpan hash-nya saja, dan
 * mengembalikan token asli SEKALI. Klaim hanya diterima selama device masih
 * pending_enrollment dan belum punya rahasia, jadi device yang sudah aktif
 * tidak bisa diambil alih hanya dengan tahu device_uuid-nya. reEnroll()
 * membuka jendela klaim lagi (rahasia lama langsung tidak berlaku).
 */
export default class DeviceEnrollmentController {
    async claim(ctx: HttpContext) {
        const data = await ctx.request.validateUsing(claimDeviceValidator, {
            // Pesan versi Laravel dari validator ini, walau ada provider global.
            messagesProvider: claimDeviceValidator.messagesProvider,
        })

        const plainSecret = generatePlainSecret()

        // FOR UPDATE di dalam transaksi supaya dua klaim bersamaan untuk
        // device yang sama tidak sama-sama lolos dan saling menimpa rahasia.
        const isClaimed = await db.transaction(async (trx) => {
            const device = await trx
                .from('devices')
                .where('device_uuid', data.device_uuid)
                .where('is_active', true)
                .where('status', 'pending_enrollment')
                .whereNull('secret_hash')
                .whereNull('deleted_at')
                .forUpdate()
                .first()

            if (!device) return false

            // Hanya secret_hash yang berubah: tidak ada atribut tercatat
            // (device_name/status/is_active), jadi tidak ada baris activity_log.
            await trx
                .from('devices')
                .where('id', device.id)
                .update({ secret_hash: hashDeviceSecret(plainSecret), updated_at: eloquentNow() })
            return true
        })

        // Pesan sengaja sama untuk "belum didaftarkan" dan "sudah diklaim"
        // supaya endpoint publik ini tidak bisa dipakai menebak status device.
        if (!isClaimed) {
            return ctx.response
                .status(404)
                .send(
                    fail(
                        'Device belum didaftarkan admin atau perlu didaftarkan ulang. Hubungi admin site.'
                    )
                )
        }

        return success('Device berhasil diaktifkan', { device_secret: plainSecret })
    }

    async reEnroll(ctx: HttpContext) {
        const device = await findDeviceOrFail(ctx.params.device)
        const access = await accessOf(ctx)
        if (!can(access, 'devices.manage')) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melakukan tindakan ini'))
        }

        if (authorizedOrganizationId(access, device.organization_id) === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang mendaftarkan ulang device ini'))
        }

        // Status 'locked' akan hilang kalau device diubah ke pending_enrollment
        // (gateway hanya mempertahankan 'locked' yang sudah tercatat), padahal
        // HP-nya masih terkunci — dashboard jadi menampilkan status yang salah.
        if (device.status === 'locked') {
            return ctx.response
                .status(422)
                .send(
                    fail(
                        'Device sedang terkunci. Buka kunci device terlebih dahulu, lalu daftarkan ulang.'
                    )
                )
        }

        await saveDevice(ctx, device, {
            secret_hash: null,
            status: 'pending_enrollment',
            updated_by: ctx.authUser!.id,
        })

        return success(
            'Device siap didaftarkan ulang. Buka aplikasi pelacak di device tersebut agar terhubung kembali.'
        )
    }
}
