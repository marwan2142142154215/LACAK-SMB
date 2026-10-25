import type { Server as SocketIoServer } from 'socket.io'
import logger from '#services/log'

/**
 * Socket /ops hanya memverifikasi token sekali saat connect (lalu dicek ulang
 * tiap 5 menit di socket.ts). Kalau token dicabut -- staf dinonaktifkan atau
 * dihapus, reset 2FA, logout, login di perangkat lain -- dashboard/APK-nya
 * harus langsung keluar. Satu query tiap SWEEP_INTERVAL_MS untuk SEMUA socket:
 * token yang sudah tidak ada (atau kedaluwarsa, atau usernya nonaktif) ->
 * `session:expired` lalu diputus, dan klien kembali ke halaman login.
 */

type OpsNamespace = ReturnType<SocketIoServer['of']>
type OpsSocket = Parameters<Parameters<OpsNamespace['on']>[1]>[0]
type Db = (typeof import('@adonisjs/lucid/services/db'))['default']

const SWEEP_INTERVAL_MS = 10_000
const LARAVEL_USER_MORPH = 'App\\Models\\User'

// Diimpor dinamis: service db butuh app sudah boot (lihat catatan di log.ts).
let dbPromise: Promise<Db> | null = null
function getDb(): Promise<Db> {
    dbPromise ??= import('@adonisjs/lucid/services/db').then(({ default: db }) => db)
    return dbPromise
}

/** Token Sanctum "{id}|{plain}" -> id; format lama tanpa id -> null (dicek tiap 5 menit). */
export function tokenIdOf(token: unknown): number | null {
    if (typeof token !== 'string') return null
    const match = /^(\d+)\|./.exec(token)
    return match ? Number(match[1]) : null
}

export function startSessionSweeper(opsNs: OpsNamespace): () => void {
    let running = false

    const timer = setInterval(async () => {
        if (running) return
        running = true
        try {
            const socketsByToken = new Map<number, OpsSocket[]>()
            for (const socket of opsNs.sockets.values()) {
                const tokenId = tokenIdOf(socket.handshake.auth?.token)
                if (tokenId === null) continue
                const list = socketsByToken.get(tokenId) ?? []
                list.push(socket)
                socketsByToken.set(tokenId, list)
            }
            if (!socketsByToken.size) return

            const db = await getDb()
            const valid = await db
                .from('personal_access_tokens')
                .join('users', 'users.id', 'personal_access_tokens.tokenable_id')
                .where('personal_access_tokens.tokenable_type', LARAVEL_USER_MORPH)
                .whereIn('personal_access_tokens.id', [...socketsByToken.keys()])
                .where((query) =>
                    query
                        .whereNull('personal_access_tokens.expires_at')
                        .orWhere('personal_access_tokens.expires_at', '>', new Date())
                )
                .whereNull('users.deleted_at')
                .where('users.is_active', true)
                .select('personal_access_tokens.id')
            const validIds = new Set(valid.map((row) => Number(row.id)))

            for (const [tokenId, sockets] of socketsByToken) {
                if (validIds.has(tokenId)) continue
                for (const socket of sockets) {
                    socket.emit('session:expired', {
                        message: 'Sesi berakhir, silakan login ulang',
                    })
                    socket.disconnect(true)
                }
            }
        } catch (error) {
            logger.error('pemeriksaan sesi socket gagal', { error })
        } finally {
            running = false
        }
    }, SWEEP_INTERVAL_MS)

    return () => clearInterval(timer)
}
