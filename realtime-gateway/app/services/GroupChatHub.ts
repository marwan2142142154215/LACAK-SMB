import type { Namespace, Socket } from 'socket.io'
import {
    fetchGroupHistory,
    fetchGroupMembers,
    fetchGroupMessage,
    groupRoom,
    postGroupMessage,
    type GroupMessagePayload,
} from '#services/chat_relay'

/** Daftar anggota hanya untuk keputusan siaran gateway, tidak diteruskan ke klien. */
function withoutMembers<T extends { member_ids?: number[] }>(data: T): Omit<T, 'member_ids'> {
    const copy = { ...data }
    delete copy.member_ids
    return copy
}

type Ack = (response: Record<string, unknown>) => void
type ChatUser = { id: number; name: string }

/**
 * Grup chat buatan user (lihat chat_relay.ts). Sama dengan chat site: izin &
 * penyimpanan selalu lewat backend dengan token user ini. Bedanya, anggota
 * grup bisa berubah kapan saja -- setiap siaran memakai member_ids terbaru
 * dari backend, dan socket yang bukan anggota lagi dikeluarkan dari ruangnya.
 */
export function registerGroupChatHandlers(
    opsNs: Namespace,
    socket: Socket,
    user: ChatUser,
    token: string
) {
    const joined = new Set<number>()
    const ack = (callback: unknown): Ack =>
        typeof callback === 'function' ? (callback as Ack) : () => {}
    const groupIdOf = (payload: { groupId?: unknown } | undefined) => {
        const groupId = Number(payload?.groupId)
        return Number.isSafeInteger(groupId) && groupId > 0 ? groupId : null
    }

    /** Siarkan pesan ke anggota saja; socket non-anggota dikeluarkan dari ruang. */
    async function deliver(groupId: number, payload: GroupMessagePayload) {
        const members = new Set(payload.member_ids ?? [])
        const message = withoutMembers(payload)
        for (const peer of await opsNs.in(groupRoom(groupId)).fetchSockets()) {
            if (peer.id === socket.id) continue
            if (members.has(peer.data.user?.id)) {
                peer.emit('chatgroup:message', message)
            } else {
                peer.leave(groupRoom(groupId))
                peer.emit('chatgroup:removed', { groupId })
            }
        }
        return message
    }

    socket.on('chatgroup:join', async (payload: { groupId?: unknown }, callback?: unknown) => {
        const groupId = groupIdOf(payload)
        if (!groupId) return ack(callback)({ ok: false, message: 'Grup tidak valid' })
        const history = await fetchGroupHistory(token, groupId)
        if (!history.ok) return ack(callback)({ ok: false, message: history.message })
        socket.join(groupRoom(groupId))
        joined.add(groupId)
        ack(callback)({ ok: true, ...withoutMembers(history.data) })
    })

    socket.on('chatgroup:leave', (payload: { groupId?: unknown }) => {
        const groupId = groupIdOf(payload)
        if (!groupId || !joined.delete(groupId)) return
        socket.leave(groupRoom(groupId))
    })

    socket.on(
        'chatgroup:history',
        async (payload: { groupId?: unknown; beforeId?: unknown }, callback?: unknown) => {
            const groupId = groupIdOf(payload)
            if (!groupId || !joined.has(groupId)) {
                return ack(callback)({ ok: false, message: 'Buka grup ini dulu' })
            }
            const history = await fetchGroupHistory(token, groupId, Number(payload?.beforeId))
            if (!history.ok) return ack(callback)({ ok: false, message: history.message })
            ack(callback)({ ok: true, ...withoutMembers(history.data) })
        }
    )

    socket.on(
        'chatgroup:send',
        async (
            payload: { groupId?: unknown; body?: unknown; replyToId?: unknown },
            callback?: unknown
        ) => {
            const groupId = groupIdOf(payload)
            if (!groupId || !joined.has(groupId)) {
                return ack(callback)({ ok: false, message: 'Buka grup ini dulu' })
            }
            if (typeof payload?.body !== 'string' || payload.body.trim() === '') {
                return ack(callback)({ ok: false, message: 'Pesan tidak boleh kosong' })
            }
            const replyToId = Number(payload?.replyToId)
            const result = await postGroupMessage(
                token,
                groupId,
                payload.body,
                Number.isSafeInteger(replyToId) && replyToId > 0 ? replyToId : undefined
            )
            if (!result.ok) return ack(callback)({ ok: false, message: result.message })
            ack(callback)({ ok: true, message: await deliver(groupId, result.data) })
        }
    )

    // Pesan bergambar diunggah dashboard langsung ke backend; di sini diambil
    // ulang dengan token user ini sebelum disiarkan (isinya tidak dari klien).
    socket.on(
        'chatgroup:announce',
        async (payload: { groupId?: unknown; messageId?: unknown }, callback?: unknown) => {
            const groupId = groupIdOf(payload)
            const messageId = Number(payload?.messageId)
            if (!groupId || !joined.has(groupId) || !Number.isSafeInteger(messageId)) {
                return ack(callback)({ ok: false, message: 'Buka grup ini dulu' })
            }
            const result = await fetchGroupMessage(token, groupId, messageId)
            if (!result.ok) return ack(callback)({ ok: false, message: result.message })
            if (result.data.user_id !== user.id) {
                return ack(callback)({ ok: false, message: 'Pesan tidak bisa disiarkan' })
            }
            await deliver(groupId, result.data)
            ack(callback)({ ok: true })
        }
    )

    socket.on('chatgroup:typing', (payload: { groupId?: unknown }) => {
        const groupId = groupIdOf(payload)
        if (!groupId || !joined.has(groupId)) return
        socket.to(groupRoom(groupId)).emit('chatgroup:typing', {
            groupId,
            user: { id: user.id, name: user.name },
        })
    })

    /**
     * Anggota grup berubah (dibuat, ditambah, dikeluarkan, diganti nama):
     * semua anggota diberi tahu supaya memuat ulang daftar grupnya, dan
     * socket yang bukan anggota lagi dikeluarkan dari ruang. Daftar anggota
     * diambil dari backend dengan token pemanggil -- harus masih anggota.
     */
    socket.on('chatgroup:changed', async (payload: { groupId?: unknown }) => {
        const groupId = groupIdOf(payload)
        if (!groupId) return
        const result = await fetchGroupMembers(token, groupId)
        if (!result.ok) return
        const members = new Set(result.data.member_ids)
        for (const peer of await opsNs.fetchSockets()) {
            const peerId = peer.data.user?.id
            if (members.has(peerId)) {
                peer.emit('chatgroup:refresh', { groupId })
            } else if (peer.rooms.has(groupRoom(groupId))) {
                peer.leave(groupRoom(groupId))
                peer.emit('chatgroup:removed', { groupId })
            }
        }
    })
}
