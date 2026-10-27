import { defineStore } from 'pinia'
import { io } from 'socket.io-client'
import { computed, ref } from 'vue'

import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

// Pesan terakhir yang sudah dibaca, per site -- disimpan per browser supaya
// badge "belum dibaca" tidak muncul lagi setelah halaman dimuat ulang.
// (Grup menyimpan tanda bacanya di server, lintas perangkat.)
const READ_KEY = 'lacak_chat_read'
const TYPING_VISIBLE_MS = 3500
// Daftar grup dimuat ulang berkala: grup baru dari orang lain, nama berubah, dikeluarkan.
const GROUPS_REFRESH_MS = 60_000

function readMarks() {
    try {
        return JSON.parse(localStorage.getItem(READ_KEY)) ?? {}
    } catch {
        return {}
    }
}

let socket = null
let groupsTimer = null
const typingTimers = new Map()

/**
 * Chat realtime lewat realtime-gateway (/ops):
 * - Ruang chat per site: user bergabung ke semua site yang boleh ia tonton
 *   (staf: site sendiri, admin/leader: site yang diberikan, super_admin: semua).
 * - Grup chat buatan user: nama bebas, anggota pilihan pembuatnya.
 * Izin & penyimpanan pesan ditegakkan backend (ChatMessagesController,
 * ChatGroupsController).
 */
export const useChatStore = defineStore('chat', () => {
    const auth = useAuthStore()

    const connected = ref(false)
    const sites = ref([])
    const activeSiteId = ref(null)
    const open = ref(false)
    const messagesBySite = ref({})
    const hasMoreBySite = ref({})
    const presenceBySite = ref({})
    const typingBySite = ref({})
    const readMarksBySite = ref(readMarks())
    const error = ref(null)
    // Pesan yang sedang dibalas (hanya berlaku di ruang yang sedang dibuka).
    const replyTo = ref(null)

    // ---- Grup
    const groups = ref([])
    const groupsLoaded = ref(false)
    const messagesByGroup = ref({})
    const hasMoreByGroup = ref({})
    const typingByGroup = ref({})
    const groupReplyTo = ref({})
    // Percakapan yang sedang terbuka di halaman Chat: { type: 'site'|'group', id }
    const pageConversation = ref(null)

    const activeMessages = computed(() => messagesBySite.value[activeSiteId.value] ?? [])
    const activePresence = computed(() => presenceBySite.value[activeSiteId.value] ?? [])
    const activeTyping = computed(() => Object.values(typingBySite.value[activeSiteId.value] ?? {}))

    function unreadCount(siteId) {
        const lastRead = readMarksBySite.value[siteId] ?? 0
        return (messagesBySite.value[siteId] ?? []).filter((m) => m.id > lastRead && m.user_id !== auth.user?.id).length
    }

    const siteUnread = computed(() => sites.value.reduce((total, site) => total + unreadCount(site.id), 0))
    const groupUnread = computed(() => groups.value.reduce((total, group) => total + (group.unread_count ?? 0), 0))
    const totalUnread = computed(() => siteUnread.value + groupUnread.value)

    function markRead(siteId = activeSiteId.value) {
        const messages = messagesBySite.value[siteId] ?? []
        const lastId = messages.at(-1)?.id
        if (!lastId || readMarksBySite.value[siteId] === lastId) return
        readMarksBySite.value = { ...readMarksBySite.value, [siteId]: lastId }
        try {
            localStorage.setItem(READ_KEY, JSON.stringify(readMarksBySite.value))
        } catch {
            // penyimpanan diblokir -- badge cuma tidak diingat setelah reload
        }
    }

    const viewingSite = (siteId) =>
        (open.value && siteId === activeSiteId.value) || (pageConversation.value?.type === 'site' && pageConversation.value.id === siteId)

    function addMessage(message) {
        const list = messagesBySite.value[message.organization_id] ?? []
        if (list.some((m) => m.id === message.id)) return
        messagesBySite.value = { ...messagesBySite.value, [message.organization_id]: [...list, message] }
        clearTyping(message.organization_id, message.user_id)
        if (viewingSite(message.organization_id)) markRead(message.organization_id)
    }

    function clearTyping(siteId, userId) {
        const current = { ...(typingBySite.value[siteId] ?? {}) }
        delete current[userId]
        typingBySite.value = { ...typingBySite.value, [siteId]: current }
    }

    function emitWithAck(event, payload) {
        return new Promise((resolve) => {
            if (!socket?.connected) return resolve({ ok: false, message: 'Chat belum tersambung, coba lagi sebentar' })
            socket
                .timeout(10_000)
                .emit(event, payload, (err, response) => resolve(err ? { ok: false, message: 'Server chat tidak menjawab' } : response))
        })
    }

    async function joinSite(siteId) {
        const response = await emitWithAck('chat:join', { organizationId: siteId })
        if (!response.ok) return
        messagesBySite.value = { ...messagesBySite.value, [siteId]: response.messages }
        hasMoreBySite.value = { ...hasMoreBySite.value, [siteId]: response.has_more }
    }

    async function start() {
        if (socket || !auth.token) return

        if (auth.hasPermission('live.watch')) {
            try {
                sites.value = (await api.get('/live/sites')).data.data
            } catch {
                sites.value = []
            }
        }
        if (sites.value.length) {
            activeSiteId.value ??= sites.value.find((s) => s.id === auth.user?.organization_id)?.id ?? sites.value[0].id
        }

        socket = io(`${import.meta.env.VITE_GATEWAY_WS_URL}/ops`, {
            transports: ['websocket'],
            auth: { token: auth.token },
        })

        // Juga terpanggil setelah reconnect -- ruang chat harus diikuti ulang.
        socket.on('connect', async () => {
            connected.value = true
            error.value = null
            await Promise.all([...sites.value.map((site) => joinSite(site.id)), loadGroups({ rejoin: true })])
        })
        socket.on('disconnect', () => (connected.value = false))
        socket.on('connect_error', () => (error.value = 'Chat tidak bisa tersambung ke server'))
        // Token dicabut (dinonaktifkan, dihapus, login di perangkat lain):
        // gateway memutus socket -> keluar ke halaman login di mana pun.
        socket.on('session:expired', async () => {
            stop()
            auth.clearSession()
            const { default: router } = await import('@/router')
            router.push({ name: 'login' })
        })

        socket.on('chat:message', addMessage)
        socket.on('chat:presence', ({ organizationId, users }) => {
            presenceBySite.value = { ...presenceBySite.value, [organizationId]: users }
        })
        socket.on('chat:typing', ({ organizationId, user }) => {
            if (user.id === auth.user?.id) return
            typingBySite.value = {
                ...typingBySite.value,
                [organizationId]: { ...(typingBySite.value[organizationId] ?? {}), [user.id]: user.name },
            }
            const key = `${organizationId}:${user.id}`
            clearTimeout(typingTimers.get(key))
            typingTimers.set(
                key,
                setTimeout(() => clearTyping(organizationId, user.id), TYPING_VISIBLE_MS),
            )
        })

        socket.on('chatgroup:message', addGroupMessage)
        socket.on('chatgroup:typing', ({ groupId, user }) => {
            if (user.id === auth.user?.id) return
            typingByGroup.value = { ...typingByGroup.value, [groupId]: { ...(typingByGroup.value[groupId] ?? {}), [user.id]: user.name } }
            const key = `g${groupId}:${user.id}`
            clearTimeout(typingTimers.get(key))
            typingTimers.set(
                key,
                setTimeout(() => clearGroupTyping(groupId, user.id), TYPING_VISIBLE_MS),
            )
        })
        socket.on('chatgroup:refresh', () => loadGroups())
        socket.on('chatgroup:removed', ({ groupId }) => dropGroup(groupId))

        clearInterval(groupsTimer)
        groupsTimer = setInterval(() => loadGroups(), GROUPS_REFRESH_MS)
    }

    function stop() {
        socket?.disconnect()
        socket = null
        clearInterval(groupsTimer)
        groupsTimer = null
        connected.value = false
        open.value = false
        sites.value = []
        messagesBySite.value = {}
        presenceBySite.value = {}
        typingBySite.value = {}
        replyTo.value = null
        groups.value = []
        groupsLoaded.value = false
        messagesByGroup.value = {}
        hasMoreByGroup.value = {}
        typingByGroup.value = {}
        groupReplyTo.value = {}
        pageConversation.value = null
    }

    function startReply(message) {
        replyTo.value = message
    }

    function cancelReply() {
        replyTo.value = null
    }

    async function send(body, siteId = activeSiteId.value) {
        const response = await emitWithAck('chat:send', {
            organizationId: siteId,
            body,
            replyToId: replyTo.value?.id,
        })
        if (!response.ok) throw new Error(response.message)
        addMessage(response.message)
        replyTo.value = null
        markRead(siteId)
    }

    /**
     * Gambar diunggah langsung ke backend-api (multipart -- terlalu besar untuk
     * socket), lalu gateway diminta menyiarkannya ke peserta lain. Gateway
     * mengambil ulang pesan itu dari backend, jadi isi siaran tidak bisa
     * dipalsukan dari sini.
     */
    async function sendImage(file, caption = '', siteId = activeSiteId.value) {
        const form = new FormData()
        form.append('organization_id', siteId)
        form.append('image', file)
        if (caption) form.append('body', caption)
        if (replyTo.value) form.append('reply_to_id', replyTo.value.id)

        const message = await uploadImage('/chat/messages', form)
        addMessage(message)
        replyTo.value = null
        markRead(siteId)
        // Gagal menyiarkan (mis. socket putus sesaat) tidak membatalkan
        // pesan -- yang lain tetap melihatnya saat memuat ulang chat.
        await emitWithAck('chat:announce', { organizationId: siteId, messageId: message.id })
    }

    async function uploadImage(path, form) {
        try {
            return (await api.post(path, form)).data.data
        } catch (err) {
            const errors = err.response?.data?.errors
            throw new Error((errors && Object.values(errors)[0]?.[0]) ?? err.response?.data?.message ?? 'Gambar gagal dikirim')
        }
    }

    async function loadOlder(siteId = activeSiteId.value) {
        const oldest = messagesBySite.value[siteId]?.[0]
        if (!oldest) return
        const response = await emitWithAck('chat:history', { organizationId: siteId, beforeId: oldest.id })
        if (!response.ok) throw new Error(response.message)
        messagesBySite.value = { ...messagesBySite.value, [siteId]: [...response.messages, ...messagesBySite.value[siteId]] }
        hasMoreBySite.value = { ...hasMoreBySite.value, [siteId]: response.has_more }
    }

    let lastTypingSent = 0
    function notifyTyping(siteId = activeSiteId.value) {
        if (Date.now() - lastTypingSent < 2000) return
        lastTypingSent = Date.now()
        socket?.emit('chat:typing', { organizationId: siteId })
    }

    // =====================================================================
    // Grup chat
    // =====================================================================

    const viewingGroup = (groupId) => pageConversation.value?.type === 'group' && pageConversation.value.id === groupId

    async function joinGroup(groupId) {
        const response = await emitWithAck('chatgroup:join', { groupId })
        if (!response.ok) return
        messagesByGroup.value = { ...messagesByGroup.value, [groupId]: response.messages }
        hasMoreByGroup.value = { ...hasMoreByGroup.value, [groupId]: response.has_more }
    }

    /** Muat daftar grup; grup baru diikuti ruangnya, grup yang hilang dilepas. */
    async function loadGroups({ rejoin = false } = {}) {
        if (!auth.token) return
        let items
        try {
            items = (await api.get('/chat/groups')).data.data.items
        } catch {
            return
        }
        const known = new Set(groups.value.map((group) => group.id))
        const current = new Set(items.map((group) => group.id))
        for (const group of groups.value) if (!current.has(group.id)) dropGroup(group.id, { leaveRoom: true })
        // Grup yang sedang dibuka: anggap sudah dibaca.
        groups.value = items.map((group) => (viewingGroup(group.id) ? { ...group, unread_count: 0 } : group))
        groupsLoaded.value = true
        const toJoin = items.filter((group) => rejoin || !known.has(group.id) || !messagesByGroup.value[group.id])
        await Promise.all(toJoin.map((group) => joinGroup(group.id)))
    }

    function dropGroup(groupId, { leaveRoom = false } = {}) {
        if (leaveRoom) socket?.emit('chatgroup:leave', { groupId })
        groups.value = groups.value.filter((group) => group.id !== groupId)
        const { [groupId]: _messages, ...rest } = messagesByGroup.value
        messagesByGroup.value = rest
        if (viewingGroup(groupId)) pageConversation.value = null
    }

    function patchGroup(groupId, patch) {
        groups.value = groups.value.map((group) => (group.id === groupId ? { ...group, ...patch } : group))
    }

    function addGroupMessage(message) {
        const groupId = message.chat_group_id
        const list = messagesByGroup.value[groupId] ?? []
        if (list.some((m) => m.id === message.id)) return
        messagesByGroup.value = { ...messagesByGroup.value, [groupId]: [...list, message] }
        clearGroupTyping(groupId, message.user_id)
        const group = groups.value.find((item) => item.id === groupId)
        if (!group) return loadGroups()
        const lastMessage = {
            id: message.id,
            user_id: message.user_id,
            user_name: message.user_name,
            body: message.body,
            has_image: !!message.image,
            created_at: message.created_at,
        }
        const own = message.user_id === auth.user?.id
        const unread = own || viewingGroup(groupId) ? 0 : (group.unread_count ?? 0) + 1
        // Percakapan terbaru naik ke atas.
        groups.value = [
            { ...group, last_message: lastMessage, unread_count: unread },
            ...groups.value.filter((item) => item.id !== groupId),
        ]
        if (!own && viewingGroup(groupId)) markGroupRead(groupId)
    }

    function clearGroupTyping(groupId, userId) {
        const current = { ...(typingByGroup.value[groupId] ?? {}) }
        delete current[userId]
        typingByGroup.value = { ...typingByGroup.value, [groupId]: current }
    }

    let readTimer = null
    function markGroupRead(groupId) {
        const messages = messagesByGroup.value[groupId] ?? []
        const group = groups.value.find((item) => item.id === groupId)
        if (!messages.length || !group) return
        const lastId = messages[messages.length - 1].id
        // Tidak ada yang berubah = jangan sentuh daftar grup (hindari render ulang beruntun).
        if (!group.unread_count && (group.last_read_message_id ?? 0) >= lastId) return
        patchGroup(groupId, { unread_count: 0, last_read_message_id: Math.max(lastId, group.last_read_message_id ?? 0) })
        if ((group.last_read_message_id ?? 0) >= lastId) return
        // Digabung: banyak pesan beruntun cukup satu permintaan.
        clearTimeout(readTimer)
        readTimer = setTimeout(() => api.post(`/chat/groups/${groupId}/read`, { message_id: lastId }).catch(() => {}), 800)
    }

    async function sendGroup(groupId, body) {
        const response = await emitWithAck('chatgroup:send', {
            groupId,
            body,
            replyToId: groupReplyTo.value[groupId]?.id,
        })
        if (!response.ok) throw new Error(response.message)
        addGroupMessage(response.message)
        setGroupReply(groupId, null)
    }

    async function sendGroupImage(groupId, file, caption = '') {
        const form = new FormData()
        form.append('image', file)
        if (caption) form.append('body', caption)
        const reply = groupReplyTo.value[groupId]
        if (reply) form.append('reply_to_id', reply.id)
        const message = await uploadImage(`/chat/groups/${groupId}/messages`, form)
        delete message.member_ids
        addGroupMessage(message)
        setGroupReply(groupId, null)
        await emitWithAck('chatgroup:announce', { groupId, messageId: message.id })
    }

    async function loadOlderGroup(groupId) {
        const oldest = messagesByGroup.value[groupId]?.[0]
        if (!oldest) return
        const response = await emitWithAck('chatgroup:history', { groupId, beforeId: oldest.id })
        if (!response.ok) throw new Error(response.message)
        messagesByGroup.value = { ...messagesByGroup.value, [groupId]: [...response.messages, ...messagesByGroup.value[groupId]] }
        hasMoreByGroup.value = { ...hasMoreByGroup.value, [groupId]: response.has_more }
    }

    function setGroupReply(groupId, message) {
        groupReplyTo.value = { ...groupReplyTo.value, [groupId]: message }
    }

    let lastGroupTypingSent = 0
    function notifyGroupTyping(groupId) {
        if (Date.now() - lastGroupTypingSent < 2000) return
        lastGroupTypingSent = Date.now()
        socket?.emit('chatgroup:typing', { groupId })
    }

    /** Beri tahu anggota (lewat gateway) bahwa grup ini berubah. */
    function announceGroupChange(groupId) {
        socket?.emit('chatgroup:changed', { groupId })
    }

    async function createGroup(name, userIds) {
        const { data } = await api.post('/chat/groups', { name, user_ids: userIds })
        await loadGroups()
        announceGroupChange(data.data.id)
        return data.data
    }

    return {
        connected,
        sites,
        activeSiteId,
        open,
        hasMoreBySite,
        messagesBySite,
        presenceBySite,
        typingBySite,
        activeMessages,
        activePresence,
        activeTyping,
        siteUnread,
        groupUnread,
        totalUnread,
        error,
        replyTo,
        unreadCount,
        markRead,
        start,
        stop,
        send,
        sendImage,
        startReply,
        cancelReply,
        loadOlder,
        notifyTyping,
        groups,
        groupsLoaded,
        messagesByGroup,
        hasMoreByGroup,
        typingByGroup,
        groupReplyTo,
        pageConversation,
        loadGroups,
        dropGroup,
        markGroupRead,
        sendGroup,
        sendGroupImage,
        loadOlderGroup,
        setGroupReply,
        notifyGroupTyping,
        announceGroupChange,
        createGroup,
    }
})
