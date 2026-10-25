import { defineStore } from 'pinia'
import { io } from 'socket.io-client'
import { computed, ref } from 'vue'

import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

// Pesan terakhir yang sudah dibaca, per site -- disimpan per browser supaya
// badge "belum dibaca" tidak muncul lagi setelah halaman dimuat ulang.
const READ_KEY = 'lacak_chat_read'
const TYPING_VISIBLE_MS = 3500

function readMarks() {
    try {
        return JSON.parse(localStorage.getItem(READ_KEY)) ?? {}
    } catch {
        return {}
    }
}

let socket = null
const typingTimers = new Map()

/**
 * Floating chat staf per site, realtime lewat realtime-gateway (/ops).
 * Satu ruang = satu site; user bergabung ke semua site yang boleh ia tonton
 * (staf: site sendiri, admin/leader: site yang diberikan, super_admin: semua)
 * supaya badge belum-dibaca tetap jalan untuk site yang tidak sedang dibuka.
 * Izin & penyimpanan pesan ditegakkan backend (ChatMessageController).
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

    const activeMessages = computed(() => messagesBySite.value[activeSiteId.value] ?? [])
    const activePresence = computed(() => presenceBySite.value[activeSiteId.value] ?? [])
    const activeTyping = computed(() => Object.values(typingBySite.value[activeSiteId.value] ?? {}))

    function unreadCount(siteId) {
        const lastRead = readMarksBySite.value[siteId] ?? 0
        return (messagesBySite.value[siteId] ?? []).filter((m) => m.id > lastRead && m.user_id !== auth.user?.id).length
    }

    const totalUnread = computed(() => sites.value.reduce((total, site) => total + unreadCount(site.id), 0))

    function markRead(siteId = activeSiteId.value) {
        const messages = messagesBySite.value[siteId] ?? []
        if (!messages.length) return
        readMarksBySite.value = { ...readMarksBySite.value, [siteId]: messages[messages.length - 1].id }
        try {
            localStorage.setItem(READ_KEY, JSON.stringify(readMarksBySite.value))
        } catch {
            // penyimpanan diblokir -- badge cuma tidak diingat setelah reload
        }
    }

    function addMessage(message) {
        const list = messagesBySite.value[message.organization_id] ?? []
        if (list.some((m) => m.id === message.id)) return
        messagesBySite.value = { ...messagesBySite.value, [message.organization_id]: [...list, message] }
        clearTyping(message.organization_id, message.user_id)
        if (open.value && message.organization_id === activeSiteId.value) markRead()
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
        if (socket || !auth.token || !auth.hasPermission('live.watch')) return

        try {
            sites.value = (await api.get('/live/sites')).data.data
        } catch {
            return
        }
        if (!sites.value.length) return
        activeSiteId.value ??= sites.value.find((s) => s.id === auth.user?.organization_id)?.id ?? sites.value[0].id

        socket = io(`${import.meta.env.VITE_GATEWAY_WS_URL}/ops`, {
            transports: ['websocket'],
            auth: { token: auth.token },
        })

        // Juga terpanggil setelah reconnect -- ruang chat harus diikuti ulang.
        socket.on('connect', async () => {
            connected.value = true
            error.value = null
            await Promise.all(sites.value.map((site) => joinSite(site.id)))
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
    }

    function stop() {
        socket?.disconnect()
        socket = null
        connected.value = false
        open.value = false
        sites.value = []
        messagesBySite.value = {}
        presenceBySite.value = {}
        typingBySite.value = {}
        replyTo.value = null
    }

    function startReply(message) {
        replyTo.value = message
    }

    function cancelReply() {
        replyTo.value = null
    }

    async function send(body) {
        const response = await emitWithAck('chat:send', {
            organizationId: activeSiteId.value,
            body,
            replyToId: replyTo.value?.id,
        })
        if (!response.ok) throw new Error(response.message)
        addMessage(response.message)
        replyTo.value = null
        markRead()
    }

    /**
     * Gambar diunggah langsung ke backend-api (multipart -- terlalu besar untuk
     * socket), lalu gateway diminta menyiarkannya ke peserta lain. Gateway
     * mengambil ulang pesan itu dari backend, jadi isi siaran tidak bisa
     * dipalsukan dari sini.
     */
    async function sendImage(file, caption = '') {
        const siteId = activeSiteId.value
        const form = new FormData()
        form.append('organization_id', siteId)
        form.append('image', file)
        if (caption) form.append('body', caption)
        if (replyTo.value) form.append('reply_to_id', replyTo.value.id)

        let message
        try {
            message = (await api.post('/chat/messages', form)).data.data
        } catch (err) {
            const errors = err.response?.data?.errors
            throw new Error((errors && Object.values(errors)[0]?.[0]) ?? err.response?.data?.message ?? 'Gambar gagal dikirim')
        }
        addMessage(message)
        replyTo.value = null
        markRead()
        // Gagal menyiarkan (mis. socket putus sesaat) tidak membatalkan
        // pesan -- yang lain tetap melihatnya saat memuat ulang chat.
        await emitWithAck('chat:announce', { organizationId: siteId, messageId: message.id })
    }

    async function loadOlder() {
        const siteId = activeSiteId.value
        const oldest = messagesBySite.value[siteId]?.[0]
        if (!oldest) return
        const response = await emitWithAck('chat:history', { organizationId: siteId, beforeId: oldest.id })
        if (!response.ok) throw new Error(response.message)
        messagesBySite.value = { ...messagesBySite.value, [siteId]: [...response.messages, ...messagesBySite.value[siteId]] }
        hasMoreBySite.value = { ...hasMoreBySite.value, [siteId]: response.has_more }
    }

    let lastTypingSent = 0
    function notifyTyping() {
        if (Date.now() - lastTypingSent < 2000) return
        lastTypingSent = Date.now()
        socket?.emit('chat:typing', { organizationId: activeSiteId.value })
    }

    return {
        connected,
        sites,
        activeSiteId,
        open,
        hasMoreBySite,
        activeMessages,
        activePresence,
        activeTyping,
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
    }
})
