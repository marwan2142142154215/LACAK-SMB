import { io } from 'socket.io-client'
import { onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'

import { useAuthStore } from '@/stores/auth'

/**
 * Koneksi Socket.IO ke realtime-gateway namespace /ops. Dipakai halaman
 * Radar & Device untuk menerima radar:update, violation:alert, device:status
 * secara langsung (lihat realtime-gateway/start/socket.ts).
 */
export function useGatewaySocket() {
    const auth = useAuthStore()
    const router = useRouter()
    const connected = ref(false)
    let socket = null

    function connect(organizationId = null) {
        socket = io(`${import.meta.env.VITE_GATEWAY_WS_URL}/ops`, {
            transports: ['websocket'],
            auth: { token: auth.token },
        })

        socket.on('connect', () => {
            connected.value = true
            if (organizationId) {
                socket.emit('subscribe:organization', organizationId)
            }
        })

        socket.on('disconnect', () => {
            connected.value = false
        })

        // Gateway mengecek ulang token tiap 5 menit (lihat socket.ts
        // registerOpsNamespace) karena koneksi socket cuma diverifikasi
        // sekali di awal -- tab yang didiamkan lama tanpa request REST apa
        // pun (jadi tidak pernah kena 401 dari interceptor di main.js) bisa
        // tetap "connect" walau sesinya sudah idle timeout 2 jam di server.
        // Event ini yang menutup celah itu: logout paksa begitu gateway
        // bilang tokennya sudah tidak valid lagi.
        socket.on('session:expired', () => {
            auth.clearSession()
            router.push({ name: 'login' })
        })

        return socket
    }

    function disconnect() {
        socket?.disconnect()
        socket = null
    }

    onBeforeUnmount(() => disconnect())

    return { connect, disconnect, connected }
}
