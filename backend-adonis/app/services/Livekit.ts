import { createHmac, randomBytes } from 'node:crypto'
import env from '#start/env'
import log from '@adonisjs/core/services/logger'

/**
 * Token LiveKit (JWT HS256) untuk Live Kerja -- padanan LiveKitTokenIssuer di
 * backend-api. Token inilah pagar isolasi: room SELALU diturunkan dari site
 * yang sudah lolos cakupan site DAN peran yang boleh ditonton, bukan dari input
 * client mentah.
 */

/**
 * Satu room Live Kerja = satu site + satu peran penyiar. Dipisah per peran
 * supaya hak tonton per peran (roles.watchable_roles) benar-benar ditegakkan
 * di LiveKit: token tonton hanya membuka room peran yang boleh ditonton.
 * organizationId null = Ruang pusat (penyiar yang tidak terikat site).
 */
export type LiveRoom = { organizationId: number | null; role: string }

/** Peran pengganti untuk sesi lama tanpa live_role (sebelum migrasi 0012). */
export const UNKNOWN_LIVE_ROLE = 'lainnya'

/** site-{id}-{peran}, atau pusat-{peran} untuk Ruang pusat. */
export const roomName = ({ organizationId, role }: LiveRoom) =>
    organizationId === null ? `pusat-${role}` : `site-${organizationId}-${role}`

/** Kebalikan roomName() untuk webhook LiveKit; null kalau bukan room Live Kerja. */
export function parseRoomName(name: string): LiveRoom | null {
    const site = /^site-(\d+)-([a-z][a-z0-9_]*)$/.exec(name)
    if (site) return { organizationId: Number(site[1]), role: site[2] }
    const central = /^pusat-([a-z][a-z0-9_]*)$/.exec(name)
    return central ? { organizationId: null, role: central[1] } : null
}

/** Room sebuah sesi kerja (site sesi + peran yang dicatat saat Mulai kerja). */
export const roomOfSession = (session: {
    organization_id: number | null
    live_role?: string | null
}): LiveRoom => ({
    organizationId: session.organization_id,
    role: session.live_role ?? UNKNOWN_LIVE_ROLE,
})

export type LiveKitConfig = {
    url: string
    apiKey: string
    apiSecret: string
    tokenTtlSeconds: number
}

export function liveKitConfig(): LiveKitConfig {
    return {
        url: env.get('LIVEKIT_URL'),
        apiKey: env.get('LIVEKIT_API_KEY'),
        apiSecret: env.get('LIVEKIT_API_SECRET').release(),
        tokenTtlSeconds: env.get('LIVEKIT_TOKEN_TTL_SECONDS', 600),
    }
}

/** Penyiar Live Kerja: menyiarkan kamera, mikrofon, layar, dan (kalau boleh) menonton rekan se-room. */
export function broadcasterToken(
    room: LiveRoom,
    userId: number,
    displayName: string,
    // Yang tidak boleh melihat rekan hanya menyiarkan, tidak menonton peserta lain di room.
    { canSubscribe = room.organizationId !== null }: { canSubscribe?: boolean } = {},
    config: LiveKitConfig = liveKitConfig(),
    now: number = Math.floor(Date.now() / 1000)
): string {
    return issue(
        `user-${userId}`,
        displayName,
        {
            room: roomName(room),
            roomJoin: true,
            canPublish: true,
            canPublishSources: ['camera', 'microphone', 'screen_share'],
            canSubscribe,
            canPublishData: false,
            canUpdateOwnMetadata: false,
        },
        config,
        now
    )
}

/** Penonton saja; `hidden` & identity acak supaya bisa dari beberapa tab sekaligus. */
export function viewerToken(
    room: LiveRoom,
    userId: number,
    displayName: string,
    config: LiveKitConfig = liveKitConfig()
): string {
    return issue(
        `viewer-${userId}-${randomBytes(4).toString('hex')}`,
        displayName,
        {
            room: roomName(room),
            roomJoin: true,
            canPublish: false,
            canSubscribe: true,
            canPublishData: false,
            canUpdateOwnMetadata: false,
            hidden: true,
        },
        config
    )
}

/**
 * Paksa keluarkan penyiar dari room-nya. Best-effort, sama seperti
 * backend-api: kegagalan hanya dicatat (404 = memang sudah tidak di room).
 */
export async function removeBroadcaster(liveRoom: LiveRoom, userId: number) {
    const config = liveKitConfig()
    const room = roomName(liveRoom)
    const httpUrl = config.url.replace(/\/+$/, '').replace(/^ws(s?):\/\//, 'http$1://')

    try {
        const response = await fetch(`${httpUrl}/twirp/livekit.RoomService/RemoveParticipant`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${issue('backend-api', 'backend-api', { room, roomAdmin: true }, config)}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ room, identity: `user-${userId}` }),
            signal: AbortSignal.timeout(5000),
        })
        if (!response.ok && response.status !== 404) {
            log.warn(
                { room, userId, status: response.status },
                'Gagal mengeluarkan staf dari room LiveKit'
            )
        }
    } catch (error) {
        log.warn({ room, userId, err: error }, 'Gagal menghubungi LiveKit untuk mengeluarkan staf')
    }
}

/** JWT persis seperti LiveKitTokenIssuer::issue() (urutan klaim & JSON sama). */
export function issue(
    identity: string,
    displayName: string,
    videoGrant: Record<string, unknown>,
    config: LiveKitConfig = liveKitConfig(),
    now: number = Math.floor(Date.now() / 1000)
): string {
    if (!config.apiKey || !config.apiSecret) {
        throw new Error('LIVEKIT_API_KEY / LIVEKIT_API_SECRET belum diisi di .env')
    }

    const claims = {
        iss: config.apiKey,
        sub: identity,
        jti: identity,
        name: displayName,
        nbf: now,
        exp: now + config.tokenTtlSeconds,
        video: videoGrant,
    }

    const segments = [
        base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
        base64Url(JSON.stringify(claims)),
    ]
    segments.push(
        base64Url(createHmac('sha256', config.apiSecret).update(segments.join('.')).digest())
    )
    return segments.join('.')
}

function base64Url(value: string | Buffer): string {
    return Buffer.from(value).toString('base64url')
}
