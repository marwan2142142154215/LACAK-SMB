import bcrypt from 'bcryptjs'

/**
 * Password bcrypt milik Laravel (`$2y$`, BCRYPT_ROUNDS=12). `$2y$` dan `$2b$`
 * algoritmanya sama -- bedanya hanya label versi PHP -- jadi hash lama tetap
 * berlaku dan hash baru disimpan sebagai `$2y$` supaya Laravel (yang masih
 * berjalan berdampingan selama migrasi) juga bisa memeriksanya.
 */
export const LARAVEL_BCRYPT_ROUNDS = 12

export async function verifyLaravelPassword(plain: string, hash: string | null): Promise<boolean> {
    if (!hash || !/^\$2[aby]\$\d{2}\$/.test(hash)) {
        return false
    }
    return bcrypt.compare(plain, hash.replace(/^\$2y\$/, '$2b$'))
}

export async function hashLaravelPassword(
    plain: string,
    rounds = LARAVEL_BCRYPT_ROUNDS
): Promise<string> {
    const hash = await bcrypt.hash(plain, rounds)
    return hash.replace(/^\$2[ab]\$/, '$2y$')
}
