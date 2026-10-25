import { createHmac, randomBytes } from 'node:crypto'
import env from '#start/env'
import log from '@adonisjs/core/services/logger'

/**
 * Token LiveKit (JWT HS256) untuk Live Kerja -- padanan LiveKitTokenIssuer di
 * backend-api. Token inilah pagar isolasi antar-site: room SELALU diturunkan
 * dari organization_id yang sudah lolos cakupan site, bukan dari input client.
 */

export const roomForOrganization = (organizationId: number) => `site-${organizationId}`

/**
 * Ruang Live Kerja leader: satu room global untuk semua leader (leader bisa
 * memegang beberapa site), hanya bisa ditonton leader, admin & root. Sesi
 * kerja leader disimpan dengan organization_id NULL.
 */
export const LEADERS_ROOM = 'leaders'

/** Room LiveKit sesi kerja: site-{id}, atau ruang leader kalau tanpa site. */
export const roomForSession = (organizationId: number | null) =>
    organizationId === null ? LEADERS_ROOM : roomForOrganization(organizationId)

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

/** Staf yang Mulai kerja: menyiarkan kamera, mikrofon, layar, dan menonton rekan se-site. */
export function broadcasterToken(
    organizationId: number | null,
    userId: number,
    displayName: string,
    // Staf biasa & leader hanya menyiarkan, tidak menonton peserta lain di room.
    { canSubscribe = organizationId !== null }: { canSubscribe?: boolean } = {},
    config: LiveKitConfig = liveKitConfig(),
    now: number = Math.floor(Date.now() / 1000)
): string {
    return issue(
        `user-${userId}`,
        displayName,
        {
            room: roomForSession(organizationId),
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
    organizationId: number | null,
    userId: number,
    displayName: string,
    config: LiveKitConfig = liveKitConfig()
): string {
    return issue(
        `viewer-${userId}-${randomBytes(4).toString('hex')}`,
        displayName,
        {
            room: roomForSession(organizationId),
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
 * Paksa keluarkan staf dari room site-nya. Best-effort, sama seperti
 * backend-api: kegagalan hanya dicatat (404 = memang sudah tidak di room).
 */
export async function removeBroadcaster(organizationId: number | null, userId: number) {
    const config = liveKitConfig()
    const room = roomForSession(organizationId)
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
