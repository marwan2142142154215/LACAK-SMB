import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { writeActivity } from '#services/activity_log'

/**
 * Wajib/tidaknya 2FA saat login, padanan App\Support\TwoFactorPolicy +
 * App\Models\AppSetting backend-api. Bawaannya WAJIB -- hanya super_admin
 * yang bisa mematikannya (dashboard Pengaturan atau perintah
 * security:two-factor), mis. untuk server uji. Saat dimatikan, login cukup
 * username/email + password; secret 2FA yang sudah terpasang tetap
 * tersimpan, jadi begitu dinyalakan lagi staf langsung memakai authenticator
 * yang sama.
 *
 * Nilai di tabel app_settings disimpan sebagai JSON (json_encode Laravel),
 * jadi kedua backend membaca baris yang sama.
 */
export const TWO_FACTOR_SETTING_KEY = 'auth.two_factor_required'

export async function isTwoFactorRequired(): Promise<boolean> {
    return phpBool(await getSetting(TWO_FACTOR_SETTING_KEY, true))
}

/**
 * @param changedByUserId pelaku perubahan (null = dari perintah konsol, atau
 *   user yang sedang login kalau `ctx` diberikan -- sama dengan causedBy(null)
 *   spatie yang tetap memakai user login).
 * @param ctx request yang memicu perubahan (untuk IP & user agent di log).
 */
export async function setTwoFactorRequired(
    required: boolean,
    changedByUserId: number | null,
    ctx: HttpContext | null = null
): Promise<void> {
    await putSetting(TWO_FACTOR_SETTING_KEY, required, changedByUserId, ctx)
}

/** AppSetting::get(): json_decode(value, true), atau default kalau barisnya tidak ada. */
export async function getSetting(key: string, fallback: unknown): Promise<unknown> {
    const row = await db.from('app_settings').where('key', key).select('value').first()
    if (!row) {
        return fallback
    }
    return decodeJson(row.value)
}

/** AppSetting::put(): updateOrCreate + log aktivitas manual (log_name app_settings). */
export async function putSetting(
    key: string,
    value: unknown,
    updatedBy: number | null,
    ctx: HttpContext | null
) {
    const existing = await db.from('app_settings').where('key', key).first()
    const old = existing ? decodeJson(existing.value) : null
    const encoded = JSON.stringify(value)
    const now = new Date()

    if (!existing) {
        await db.table('app_settings').insert({
            key,
            value: encoded,
            updated_by: updatedBy,
            created_at: now,
            updated_at: now,
        })
    } else if (existing.value !== encoded || (existing.updated_by ?? null) !== updatedBy) {
        // updateOrCreate Eloquent hanya menyimpan kalau ada kolom yang berubah.
        await db
            .from('app_settings')
            .where('key', key)
            .update({ value: encoded, updated_by: updatedBy, updated_at: now })
    }

    // Dicatat manual seperti backend-api (bukan trait LogsActivity):
    // subject_id di activity_log bertipe bigint, sedangkan primary key
    // app_settings teks. Site log = site pelaku (AppServiceProvider).
    const causerId = updatedBy ?? ctx?.authUser?.id ?? null
    const causer =
        causerId === null
            ? null
            : await db.from('users').where('id', causerId).select('organization_id').first()

    await writeActivity(ctx, {
        logName: 'app_settings',
        description: `Pengaturan ${key} diubah`,
        event: null,
        subjectType: null,
        subjectId: null,
        causerId,
        properties: { key, old, new: value },
        organizationId: causer?.organization_id ?? null,
    })
}

function decodeJson(value: string | null): unknown {
    if (value === null) {
        return null
    }
    try {
        return JSON.parse(value)
    } catch {
        return null
    }
}

/** Cast (bool) PHP atas hasil json_decode. */
export function phpBool(value: unknown): boolean {
    if (value === null || value === undefined || value === false) return false
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') return value !== '' && value !== '0'
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === 'object') return Object.keys(value).length > 0
    return Boolean(value)
}
