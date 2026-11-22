import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { accessOf, can } from '#services/Access'
import { writeActivity } from '#services/ActivityLog'
import { fail, success } from '#services/ApiResponse'
import { escapeLike, searchTermOf } from '#services/SearchTerm'
import {
    authorizedOrganizationId,
    canAccessOrganization,
    organizationFilter,
} from '#services/OrganizationScope'
import {
    deviceResource,
    eloquentNow,
    findDeviceOrFail,
    latestCommandsOf,
    latestLocationsOf,
    logDeviceCreated,
    logDeviceDeleted,
    DEVICE_MORPH,
    paginate,
    phpIntval,
    saveDevice,
    type DeviceRow,
} from '#services/DeviceResource'
import {
    moveDeviceSiteValidator,
    setDeviceGeofenceValidator,
    setDeviceHolderValidator,
    storeDeviceValidator,
    updateDeviceValidator,
} from '#validators/Devices'

/**
 * Padanan DeviceController (apiResource 'devices') di backend-api, kontrak sama.
 * Device memakai SoftDeletes: device yang sudah dihapus tidak muncul di daftar
 * dan dianggap tidak ada (404) di semua endpoint {device}.
 */
export default class DevicesController {
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'devices.view')) return forbidden(ctx)

        const requested = phpIntval(ctx.request.input('organization_id')) || null
        const scope = organizationFilter(access, requested)
        if (scope === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melihat device site ini'))
        }

        const rawStatus = ctx.request.input('status')
        const status = rawStatus === null || rawStatus === undefined ? '' : String(rawStatus)

        const search = searchTermOf(ctx.request.input('search'))

        // Site yang boleh dilihat + pencarian (nama, UUID, kode site, atau nama site), tanpa filter status.
        const matching = () => {
            const query = db.from('devices').whereNull('deleted_at')
            if (scope !== 'all') query.whereIn('organization_id', scope)
            if (search) {
                const pattern = `%${escapeLike(search)}%`
                query.where((match) =>
                    match
                        .whereILike('device_name', pattern)
                        .orWhereILike('device_uuid', pattern)
                        .orWhereILike('site_code_embedded', pattern)
                        .orWhereIn(
                            'organization_id',
                            db
                                .from('organizations')
                                .whereNull('deleted_at')
                                .whereILike('name', pattern)
                                .select('id')
                        )
                )
            }
            return query
        }

        const [{ rows, total }, statusRows] = await Promise.all([
            paginate(ctx, () => {
                const query = matching()
                if (status) query.where('status', status)
                return query.orderBy('device_name').orderBy('id').select('*')
            }),
            matching().select('status').count('* as total').groupBy('status'),
        ])
        const countsByStatus = Object.fromEntries(
            statusRows.map((row) => [String(row.status), Number(row.total)])
        )

        const devices = rows as DeviceRow[]
        // Lokasi device (koordinat, jarak BLE) hanya untuk pemegang izin radar.view; tanpa itu kuncinya
        // tidak ikut dikirim sama sekali, jadi tidak bocor lewat API walau halaman Radar disembunyikan.
        const withLocation = can(access, 'radar.view')
        const deviceIds = devices.map((device) => device.id)
        const [organizations, locations, commands] = await Promise.all([
            organizationNamesOf(devices.map((device) => device.organization_id)),
            latestLocationsOf(withLocation ? deviceIds : []),
            // Status perintah terakhir (terkirim/diterima/dijalankan/gagal) per device.
            latestCommandsOf(deviceIds),
        ])

        return success('Daftar device', {
            items: devices.map((device) =>
                deviceResource(device, {
                    // Site yang sudah di-soft-delete tidak ikut dimuat relasinya.
                    organizationName: organizations.get(device.organization_id) ?? null,
                    latestLocation: withLocation ? (locations.get(device.id) ?? null) : undefined,
                    latestCommand: commands.get(device.id) ?? null,
                })
            ),
            total,
            counts_by_status: countsByStatus,
            total_all: Object.values(countsByStatus).reduce((sum, count) => sum + count, 0),
        })
    }

    async store(ctx: HttpContext) {
        // FormRequest: authorize() lebih dulu, baru validasi.
        const access = await accessOf(ctx)
        if (!can(access, 'devices.manage')) return forbidden(ctx)

        const input = await ctx.request.validateUsing(storeDeviceValidator, {
            // Pesan versi Laravel dari validator ini, walau ada provider global.
            messagesProvider: storeDeviceValidator.messagesProvider,
        })

        const organizationId = authorizedOrganizationId(access, input.organization_id)
        if (organizationId === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang mendaftarkan device untuk site ini'))
        }

        const now = eloquentNow()
        const userId = ctx.authUser!.id
        const values = {
            organization_id: organizationId,
            consent_document_id: null,
            device_name: input.device_name,
            device_uuid: input.device_uuid,
            android_version: input.android_version,
            app_build_version: input.app_build_version,
            site_code_embedded: input.site_code_embedded,
            status: 'pending_enrollment',
            enrolled_at: now,
            is_active: true,
            created_by: userId,
            updated_by: userId,
            created_at: now,
            updated_at: now,
        }
        const [{ id }] = await db.table('devices').insert(values).returning(['id'])

        // Atribut yang tidak diisi saat create (battery_level, last_seen_at)
        // bernilai null di model Laravel yang baru dibuat.
        const device: DeviceRow = {
            id: Number(id),
            ...values,
            battery_level: null,
            last_ssid: null,
            last_seen_at: null,
        }
        await logDeviceCreated(ctx, device)

        return ctx.response
            .status(201)
            .send(success('Device berhasil didaftarkan', deviceResource(device)))
    }

    async show(ctx: HttpContext) {
        const device = await findDeviceOrFail(ctx.params.device)
        const access = await accessOf(ctx)
        if (!can(access, 'devices.view')) return forbidden(ctx)

        if (!canAccessOrganization(access, device.organization_id)) {
            return ctx.response.status(403).send(fail('Anda tidak berwenang melihat device ini'))
        }

        const withLocation = can(access, 'radar.view')
        const [locations, commands] = await Promise.all([
            latestLocationsOf(withLocation ? [device.id] : []),
            latestCommandsOf([device.id]),
        ])

        return success(
            'Detail device',
            deviceResource(device, {
                latestLocation: withLocation ? (locations.get(device.id) ?? null) : undefined,
                latestCommand: commands.get(device.id) ?? null,
            })
        )
    }

    async update(ctx: HttpContext) {
        // Urutan Laravel: route model binding (404) -> authorize (403) -> validasi (422).
        const device = await findDeviceOrFail(ctx.params.device)
        const access = await accessOf(ctx)
        if (!can(access, 'devices.manage')) return forbidden(ctx)

        const input = await ctx.request.validateUsing(updateDeviceValidator, {
            // Pesan versi Laravel dari validator ini, walau ada provider global.
            messagesProvider: updateDeviceValidator.messagesProvider,
        })

        if (!canAccessOrganization(access, device.organization_id)) {
            return ctx.response.status(403).send(fail('Anda tidak berwenang mengubah device ini'))
        }

        const updated = await saveDevice(ctx, device, {
            ...(input.device_name !== undefined ? { device_name: input.device_name } : {}),
            ...(input.is_active !== undefined ? { is_active: Boolean(input.is_active) } : {}),
            updated_by: ctx.authUser!.id,
        })

        return success('Device berhasil diperbarui', deviceResource(updated))
    }

    /**
     * Pindahkan device ke site lain tanpa pasang ulang APK. site_code_embedded
     * sengaja TIDAK diubah -- gateway mencocokkan kode APK ke nilai itu, jadi
     * device tetap bisa terhubung. Butuh wewenang atas site asal DAN tujuan.
     */
    async moveSite(ctx: HttpContext) {
        const device = await findDeviceOrFail(ctx.params.device)
        const access = await accessOf(ctx)
        if (!can(access, 'devices.manage')) return forbidden(ctx)

        if (!canAccessOrganization(access, device.organization_id)) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang memindahkan device ini'))
        }

        const input = await ctx.request.validateUsing(moveDeviceSiteValidator, {
            messagesProvider: moveDeviceSiteValidator.messagesProvider,
        })

        const target = authorizedOrganizationId(access, input.organization_id)
        if (target === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang memindahkan ke site tujuan'))
        }
        if (target === device.organization_id) {
            return ctx.response.status(422).send(fail('Device sudah berada di site ini'))
        }

        const org = await db
            .from('organizations')
            .where('id', target)
            .whereNull('deleted_at')
            .select('id', 'name', 'is_active')
            .first()
        if (!org || !org.is_active) {
            return ctx.response.status(422).send(fail('Site tujuan tidak ditemukan atau nonaktif'))
        }

        const now = eloquentNow()
        await db
            .from('devices')
            .where('id', device.id)
            .update({ organization_id: target, updated_by: ctx.authUser!.id, updated_at: now })
        await writeActivity(ctx, {
            logName: 'devices',
            description: `Memindahkan device "${device.device_name}" ke site ${org.name}`,
            event: 'updated',
            subjectType: DEVICE_MORPH,
            subjectId: device.id,
            properties: {
                from_organization_id: device.organization_id,
                to_organization_id: target,
            },
            organizationId: target,
        })

        return success('Device dipindahkan ke site lain', { organization_id: target })
    }

    /**
     * Pasang/hapus pagar GPS milik HP ini (selain aturan geofence per-site).
     * Keluar radius -> auto-lock oleh gateway (lihat GeofenceEvaluator). Semua
     * field null = hapus pagar; semua terisi = pasang.
     */
    async setGeofence(ctx: HttpContext) {
        const device = await findDeviceOrFail(ctx.params.device)
        const access = await accessOf(ctx)
        if (!can(access, 'devices.manage')) return forbidden(ctx)

        if (!canAccessOrganization(access, device.organization_id)) {
            return ctx.response.status(403).send(fail('Anda tidak berwenang mengubah pagar device ini'))
        }

        const input = await ctx.request.validateUsing(setDeviceGeofenceValidator, {
            messagesProvider: setDeviceGeofenceValidator.messagesProvider,
        })

        // "Semua atau tidak sama sekali": kalau ada satu yang null, perlakukan sebagai hapus pagar.
        const clearing =
            input.latitude === null || input.longitude === null || input.radius_meters === null
        const lat = clearing ? null : input.latitude
        const lng = clearing ? null : input.longitude
        const radius = clearing ? null : input.radius_meters

        const now = eloquentNow()
        await db.from('devices').where('id', device.id).update({
            geofence_latitude: lat,
            geofence_longitude: lng,
            geofence_radius_meters: radius,
            updated_by: ctx.authUser!.id,
            updated_at: now,
        })
        await writeActivity(ctx, {
            logName: 'devices',
            description: clearing
                ? `Menghapus pagar lokasi device "${device.device_name}"`
                : `Memasang pagar lokasi device "${device.device_name}" (radius ${radius}m)`,
            event: 'updated',
            subjectType: DEVICE_MORPH,
            subjectId: device.id,
            properties: {
                geofence_latitude: lat,
                geofence_longitude: lng,
                geofence_radius_meters: radius,
            },
            organizationId: device.organization_id,
        })

        return success(clearing ? 'Pagar lokasi device dihapus' : 'Pagar lokasi device dipasang', {
            geofence_latitude: lat,
            geofence_longitude: lng,
            geofence_radius_meters: radius,
        })
    }

    /**
     * Tetapkan / lepas STAF PEMEGANG HP ini. Dipakai kunci per-shift-staf
     * (StaffShiftDeviceLock): saat site menyalakan staff_shift_lock, HP dikunci
     * mengikuti shift pemegangnya. null = lepas pemegang. Pemegang wajib staf
     * yang punya akses ke site HP ini (home org atau site access).
     */
    async setHolder(ctx: HttpContext) {
        const device = await findDeviceOrFail(ctx.params.device)
        const access = await accessOf(ctx)
        if (!can(access, 'devices.manage')) return forbidden(ctx)

        if (!canAccessOrganization(access, device.organization_id)) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang mengubah pemegang device ini'))
        }

        const input = await ctx.request.validateUsing(setDeviceHolderValidator, {
            messagesProvider: setDeviceHolderValidator.messagesProvider,
        })

        const holderId = input.holder_user_id ?? null
        let holderName: string | null = null
        if (holderId !== null) {
            const holder = await db
                .from('users')
                .where('id', holderId)
                .whereNull('deleted_at')
                .select('id', 'name', 'organization_id')
                .first()
            if (!holder) {
                return ctx.response.status(422).send(fail('Staf yang dipilih tidak ditemukan.'))
            }
            let belongs = Number(holder.organization_id) === Number(device.organization_id)
            if (!belongs) {
                const siteAccess = await db
                    .from('user_site_access')
                    .where('user_id', holderId)
                    .where('organization_id', device.organization_id)
                    .first()
                belongs = Boolean(siteAccess)
            }
            if (!belongs) {
                return ctx.response
                    .status(422)
                    .send(fail('Staf yang dipilih bukan bagian dari site device ini.'))
            }
            holderName = holder.name
        }

        const now = eloquentNow()
        await db.from('devices').where('id', device.id).update({
            holder_user_id: holderId,
            updated_by: ctx.authUser!.id,
            updated_at: now,
        })
        await writeActivity(ctx, {
            logName: 'devices',
            description:
                holderId === null
                    ? `Melepas pemegang device "${device.device_name}"`
                    : `Menetapkan pemegang device "${device.device_name}": ${holderName}`,
            event: 'updated',
            subjectType: DEVICE_MORPH,
            subjectId: device.id,
            properties: { holder_user_id: holderId },
            organizationId: device.organization_id,
        })

        return success(holderId === null ? 'Pemegang device dilepas' : 'Pemegang device ditetapkan', {
            holder_user_id: holderId,
            holder_name: holderName,
        })
    }

    async destroy(ctx: HttpContext) {
        const device = await findDeviceOrFail(ctx.params.device)
        const access = await accessOf(ctx)
        if (!can(access, 'devices.manage')) return forbidden(ctx)

        if (!canAccessOrganization(access, device.organization_id)) {
            return ctx.response.status(403).send(fail('Anda tidak berwenang menghapus device ini'))
        }

        // Pengaman: jangan hapus device yang sedang TERKUNCI. Setelah terhapus (soft delete),
        // device 404 di semua endpoint -> perintah buka-kunci maupun OTP tak bisa lagi menjangkau
        // HP, sehingga HP terjebak terkunci permanen. Buka kunci dulu, baru hapus.
        if (device.status === 'locked') {
            return ctx.response
                .status(422)
                .send(fail('Device sedang terkunci. Buka kunci dulu sebelum menghapus, agar HP tidak terjebak terkunci.'))
        }

        // Soft delete Eloquent: deleted_at & updated_at diisi waktu yang sama.
        const now = eloquentNow()
        await db.from('devices').where('id', device.id).update({ deleted_at: now, updated_at: now })
        await logDeviceDeleted(ctx, device)

        return success('Device berhasil dihapus (soft delete)')
    }
}

/** Nama site per id (relasi organization, tanpa site yang sudah di-soft-delete). */
async function organizationNamesOf(ids: number[]) {
    const unique = [...new Set(ids)]
    if (!unique.length) return new Map<number, string>()
    const rows = await db
        .from('organizations')
        .whereIn('id', unique)
        .whereNull('deleted_at')
        .select('id', 'name')
    return new Map(rows.map((row) => [Number(row.id), row.name as string]))
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang melakukan tindakan ini'))
}
