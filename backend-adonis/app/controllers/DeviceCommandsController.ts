import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { accessOf, can } from '#services/access'
import { fail, success } from '#services/api_response'
import { authorizedOrganizationId } from '#services/organization_scope'
import {
    deviceCommandResource,
    eloquentNow,
    findDeviceOrFail,
    logDeviceUpdated,
    paginate,
    updateDevice,
} from '#services/device_resource'
import { storeDeviceCommandValidator, type COMMAND_TYPES } from '#validators/devices'

/** Izin yang dibutuhkan per jenis perintah. */
export const COMMAND_PERMISSIONS: Record<(typeof COMMAND_TYPES)[number], string> = {
    lock: 'devices.lock',
    unlock: 'devices.unlock',
    locate_now: 'devices.locate',
    start_monitor: 'devices.monitor',
    stop_monitor: 'devices.monitor',
}

/**
 * Perintah ke device (lock/unlock/start_monitor/stop_monitor/locate_now).
 * Setiap perintah WAJIB tercatat siapa yang mengeluarkan (issued_by) — ini
 * jejak audit yang dipakai pertanggungjawaban hukum (surat consent).
 *
 * Controller ini hanya mencatat perintah dengan status 'pending';
 * realtime-gateway yang mengirimkannya ke device dan mengubah statusnya ke
 * 'delivered'/'acknowledged'. Padanan DeviceCommandController di backend-api.
 */
export default class DeviceCommandsController {
    async index(ctx: HttpContext) {
        const device = await findDeviceOrFail(ctx.params.device)
        const access = await accessOf(ctx)
        if (!can(access, 'devices.view')) return forbidden(ctx)

        if (authorizedOrganizationId(access, device.organization_id) === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melihat riwayat perintah device ini'))
        }

        const { rows, total } = await paginate(ctx, () =>
            db
                .from('device_commands')
                .where('device_id', device.id)
                .orderBy('created_at', 'desc')
                .select('*')
        )

        return success('Riwayat perintah', { items: rows.map(deviceCommandResource), total })
    }

    async store(ctx: HttpContext) {
        const device = await findDeviceOrFail(ctx.params.device)
        // Laravel memvalidasi isian dulu, baru memeriksa izin per jenis perintah.
        const data = await ctx.request.validateUsing(storeDeviceCommandValidator, {
            // Pesan versi Laravel dari validator ini, walau ada provider global.
            messagesProvider: storeDeviceCommandValidator.messagesProvider,
        })

        const access = await accessOf(ctx)
        if (!can(access, COMMAND_PERMISSIONS[data.command_type])) return forbidden(ctx)

        if (authorizedOrganizationId(access, device.organization_id) === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang mengirim perintah ke device ini'))
        }

        if (!device.is_active) {
            return ctx.response
                .status(422)
                .send(fail('Device dinonaktifkan, tidak bisa menerima perintah'))
        }

        const userId = ctx.authUser!.id
        const { command, updated } = await db.transaction(async (trx) => {
            const now = eloquentNow()
            const [row] = await trx
                .table('device_commands')
                .insert({
                    device_id: device.id,
                    command_type: data.command_type,
                    issued_by: userId,
                    issued_via: data.issued_via,
                    status: 'pending',
                    reason_note: data.reason_note ?? null,
                    created_at: now,
                    updated_at: now,
                })
                .returning('*')

            let after = device
            if (data.command_type === 'lock') {
                after = await updateDevice(device, { status: 'locked', updated_by: userId }, trx)
            } else if (data.command_type === 'unlock') {
                after = await updateDevice(device, { status: 'online', updated_by: userId }, trx)
            }

            return { command: row, updated: after }
        })

        await logDeviceUpdated(ctx, device, updated)

        return ctx.response
            .status(201)
            .send(
                success(
                    'Perintah berhasil dikirim, menunggu diterima device',
                    deviceCommandResource(command)
                )
            )
    }
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang melakukan tindakan ini'))
}
