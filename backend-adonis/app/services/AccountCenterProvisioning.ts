import { randomBytes } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import { hashLaravelPassword } from '#services/laravel/Bcrypt'

/**
 * Pendaftaran otomatis akun Account Center yang belum ada di Lacak SMB.
 *
 * Account Center hanya membuktikan identitas (email + password sah). Akun yang
 * dibuat di sini SENGAJA belum bisa dipakai: nonaktif (is_active = false) dan
 * tanpa peran maupun akses site. Super admin yang menentukan peran & site
 * lalu mengaktifkannya -- jadi tidak semua orang yang punya Account Center
 * otomatis mendapat akses ke data perusahaan.
 */
const MIN_USERNAME_LENGTH = 3
const MAX_USERNAME_LENGTH = 40
const MAX_USERNAME_ATTEMPTS = 50

export const autoProvisionEnabled = (): boolean => env.get('ACCOUNTCENTER_AUTO_PROVISION') ?? false

/** "Budi.Santoso+x@gmail.com" -> "budi.santosox": huruf kecil, angka, titik, strip, garis bawah. */
export function usernameFromEmail(email: string): string {
    const local = email.split('@')[0] ?? ''
    const cleaned = local
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '')
        .slice(0, MAX_USERNAME_LENGTH)
    return cleaned.length >= MIN_USERNAME_LENGTH ? cleaned : `user${cleaned}`
}

async function freeUsername(base: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt++) {
        const candidate = attempt === 0 ? base : `${base}${attempt + 1}`
        const taken = await db.from('users').whereRaw('LOWER(username) = ?', [candidate]).first()
        if (!taken) return candidate
    }
    return `${base}${randomBytes(3).toString('hex')}`
}

/** Buat akun menunggu aktivasi. Mengembalikan id, atau null kalau email sudah dipakai (balapan). */
export async function provisionPendingUser(
    email: string,
    displayName: string | null
): Promise<number | null> {
    const normalizedEmail = email.trim().toLowerCase()
    const username = await freeUsername(usernameFromEmail(normalizedEmail))
    // Akun ini masuk lewat Account Center, jadi password lokalnya tidak pernah dipakai.
    const password = await hashLaravelPassword(randomBytes(32).toString('base64url'))
    const now = new Date()

    try {
        const [created] = await db
            .table('users')
            .insert({
                name: displayName?.trim() || username,
                username,
                email: normalizedEmail,
                password,
                organization_id: null,
                is_active: false,
                created_at: now,
                updated_at: now,
            })
            .returning('id')
        return Number(typeof created === 'object' ? created.id : created)
    } catch (error) {
        // 23505 = unique_violation: login ganda bersamaan, akunnya sudah dibuat permintaan lain.
        if ((error as { code?: string }).code === '23505') return null
        throw error
    }
}
