import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { accessOf, can } from '#services/access'
import { fail, success } from '#services/api_response'
import {
    buildBlockList,
    getIpWhitelist,
    ipMatches,
    MAX_ENTRIES,
    normalizeEntry,
    normalizeIp,
    setIpWhitelist,
    type IpWhitelistEntry,
} from '#services/ip_whitelist'
import { isTwoFactorRequired, setTwoFactorRequired } from '#services/two_factor_policy'
import { laravelBoolean, laravelInput, laravelMessages } from '#validators/users'

const securitySettingValidator = vine.create({
    two_factor_required: laravelBoolean(),
})

/**
 * Pengaturan keamanan sistem yang bisa diubah dari dashboard -- hanya
 * pemegang permission security.manage (super_admin). Padanan
 * SecuritySettingController di backend-api.
 */
export default class SecuritySettingsController {
    async show(ctx: HttpContext) {
        if (!(await canManage(ctx))) return forbidden(ctx)

        return success('Pengaturan keamanan', {
            two_factor_required: await isTwoFactorRequired(),
        })
    }

    async update(ctx: HttpContext) {
        if (!(await canManage(ctx))) return forbidden(ctx)

        const data = await securitySettingValidator.validate(laravelInput(ctx), {
            messagesProvider: laravelMessages,
        })
        const required = data.two_factor_required as boolean

        await setTwoFactorRequired(required, ctx.authUser!.id, ctx)

        return success(
            required
                ? '2FA kembali wajib saat login'
                : '2FA dimatikan: login cukup dengan password',
            { two_factor_required: await isTwoFactorRequired() }
        )
    }

    /** Whitelist IP global + IP pemanggil (untuk tombol "tambahkan IP saya"). */
    async ipWhitelist(ctx: HttpContext) {
        if (!(await canManage(ctx))) return forbidden(ctx)

        return success('Whitelist IP', await whitelistPayload(ctx))
    }

    async updateIpWhitelist(ctx: HttpContext) {
        if (!(await canManage(ctx))) return forbidden(ctx)

        const body = ctx.request.body() as { enabled?: unknown; entries?: unknown }
        const errors: Record<string, string[]> = {}
        const enabled = body.enabled === true
        const rawEntries = Array.isArray(body.entries) ? body.entries : null
        const entries: IpWhitelistEntry[] = []

        if (typeof body.enabled !== 'boolean') {
            errors.enabled = ['Kolom enabled harus bernilai true atau false.']
        }
        if (!rawEntries) {
            errors.entries = ['Daftar IP wajib berupa array.']
        } else if (rawEntries.length > MAX_ENTRIES) {
            errors.entries = [`Maksimal ${MAX_ENTRIES} IP.`]
        } else {
            const seen = new Set<string>()
            rawEntries.forEach((raw, index) => {
                const entry = (raw ?? {}) as { value?: unknown; label?: unknown }
                const value = typeof entry.value === 'string' ? normalizeEntry(entry.value) : null
                const label = typeof entry.label === 'string' ? entry.label.trim() : ''
                if (!value) {
                    errors[`entries.${index}.value`] = [
                        'Isi alamat IP (mis. 103.10.20.30) atau rentang CIDR (mis. 192.168.1.0/24).',
                    ]
                } else if (label.length > 60) {
                    errors[`entries.${index}.label`] = ['Keterangan maksimal 60 karakter.']
                } else if (!seen.has(value)) {
                    seen.add(value)
                    entries.push({ value, label })
                }
            })
        }
        if (enabled && rawEntries && rawEntries.length === 0) {
            errors.entries = ['Tambahkan minimal satu IP sebelum mengaktifkan whitelist.']
        }
        if (Object.keys(errors).length) {
            return ctx.response.status(422).send(fail('Data whitelist IP tidak valid', errors))
        }

        await setIpWhitelist({ enabled, entries }, ctx.authUser!.id, ctx)

        return success(
            enabled
                ? `Whitelist IP aktif: ${entries.length} IP/rentang diizinkan`
                : 'Whitelist IP dimatikan: akses dari IP mana saja',
            await whitelistPayload(ctx)
        )
    }
}

/** Daftar + IP pemanggil & apakah IP itu termasuk daftar (peringatan di dashboard). */
async function whitelistPayload(ctx: HttpContext) {
    const list = await getIpWhitelist()
    const currentIp = normalizeIp(ctx.request.ip())
    return {
        ...list,
        current_ip: currentIp,
        current_ip_allowed: ipMatches(buildBlockList(list.entries), currentIp),
    }
}

async function canManage(ctx: HttpContext) {
    return can(await accessOf(ctx), 'security.manage')
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang melakukan tindakan ini'))
}
