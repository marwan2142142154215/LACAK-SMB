import axios from 'axios'
import env from '#start/env'
import log from '#services/log'
import { describeHttpError } from '#services/http_error'
import { userHeaders } from '#services/client_ip'

/**
 * Chat staf per site. Gateway TIDAK menyimpan pesan dan TIDAK memutuskan
 * siapa boleh masuk ruang chat mana: keduanya diteruskan ke backend-api
 * (ChatMessageController) memakai token user yang sedang chat. Gateway
 * hanya menyiarkan pesan yang sudah diterima backend ke semua socket di
 * ruang site itu, supaya muncul seketika tanpa polling.
 */

export type ChatMessagePayload = {
    id: number
    organization_id: number
    user_id: number
    user_name: string | null
    body: string | null
    image: { url: string; width: number | null; height: number | null } | null
    reply_to: {
        id: number
        user_name: string | null
        body: string | null
        has_image: boolean
    } | null
    created_at: string
}

export type ChatHistory = {
    organization_id: number
    messages: ChatMessagePayload[]
    has_more: boolean
}

type BackendResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string }

const GROUPS_PATH = '/api/v1/chat/groups'

export function chatRoom(organizationId: number) {
    return `chat:org:${organizationId}`
}

async function callBackend<T>(
    token: string,
    method: 'get' | 'post',
    params: Record<string, unknown>,
    path = '',
    base = '/api/v1/chat/messages'
): Promise<BackendResult<T>> {
    try {
        const response = await axios.request({
            method,
            url: `${env.get('BACKEND_API_URL')}${base}${path}`,
            headers: userHeaders(token),
            ...(method === 'get' ? { params } : { data: params }),
            timeout: 10_000,
            // 4xx (ditolak, validasi, throttle) adalah jawaban normal untuk diteruskan ke user.
            validateStatus: () => true,
        })

        if (response.status >= 200 && response.status < 300 && response.data?.success) {
            return { ok: true, data: response.data.data as T }
        }

        return {
            ok: false,
            status: response.status,
            message:
                response.status === 429
                    ? 'Terlalu banyak pesan, tunggu sebentar'
                    : (response.data?.message ?? 'Permintaan chat ditolak'),
        }
    } catch (error) {
        log.error('gagal meneruskan chat ke backend-api', describeHttpError(error))
        return { ok: false, status: 503, message: 'Server chat sedang tidak bisa dihubungi' }
    }
}

/** Sekaligus cek izin: 200 = boleh masuk ruang chat site ini. */
export function fetchChatHistory(token: string, organizationId: number, beforeId?: number) {
    return callBackend<ChatHistory>(token, 'get', {
        organization_id: organizationId,
        ...(beforeId ? { before_id: beforeId } : {}),
    })
}

export function postChatMessage(
    token: string,
    organizationId: number,
    body: string,
    replyToId?: number
) {
    return callBackend<ChatMessagePayload>(token, 'post', {
        organization_id: organizationId,
        body,
        ...(replyToId ? { reply_to_id: replyToId } : {}),
    })
}

/**
 * Pesan bergambar diunggah dashboard langsung ke backend-api (multipart);
 * gateway mengambil pesan jadinya dengan token user itu -- sekaligus cek
 * izin -- sebelum menyiarkannya. Isi siaran tidak pernah dari klien.
 */
export function fetchChatMessage(token: string, messageId: number) {
    return callBackend<ChatMessagePayload>(token, 'get', {}, `/${messageId}`)
}

/* ---------------------------------------------------------------------
 | Grup chat buatan user (ChatGroupsController di backend). Jawaban pesan
 | membawa member_ids: gateway hanya menyiarkan ke socket milik anggota
 | yang masih tercatat, lalu mengeluarkan socket lain dari ruangnya.
 * ------------------------------------------------------------------- */

export type GroupMessagePayload = Omit<ChatMessagePayload, 'organization_id'> & {
    organization_id: null
    chat_group_id: number
    member_ids?: number[]
}

export type GroupHistory = {
    chat_group_id: number
    messages: ChatMessagePayload[]
    has_more: boolean
    member_ids: number[]
}

export function groupRoom(groupId: number) {
    return `chat:group:${groupId}`
}

export function fetchGroupHistory(token: string, groupId: number, beforeId?: number) {
    return callBackend<GroupHistory>(
        token,
        'get',
        beforeId ? { before_id: beforeId } : {},
        `/${groupId}/messages`,
        GROUPS_PATH
    )
}

export function postGroupMessage(token: string, groupId: number, body: string, replyToId?: number) {
    return callBackend<GroupMessagePayload>(
        token,
        'post',
        { body, ...(replyToId ? { reply_to_id: replyToId } : {}) },
        `/${groupId}/messages`,
        GROUPS_PATH
    )
}

export function fetchGroupMessage(token: string, groupId: number, messageId: number) {
    return callBackend<GroupMessagePayload>(
        token,
        'get',
        {},
        `/${groupId}/messages/${messageId}`,
        GROUPS_PATH
    )
}

/** Anggota grup saat ini (sekaligus cek: pemanggil masih anggota). */
export function fetchGroupMembers(token: string, groupId: number) {
    return callBackend<{ member_ids: number[] }>(token, 'get', {}, `/${groupId}`, GROUPS_PATH)
}
