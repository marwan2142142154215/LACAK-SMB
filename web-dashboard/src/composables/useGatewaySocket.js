import { io } from 'socket.io-client'
import { onBeforeUnmount, ref } from 'vue'

import { useAuthStore } from '@/stores/auth'

/**
 * Koneksi Socket.IO ke realtime-gateway namespace /ops. Dipakai halaman
 * Radar & Device untuk menerima radar:update, violation:alert, device:status
 * secara langsung (lihat realtime-gateway/start/socket.ts).
 */
export function useGatewaySocket() {
    const auth = useAuthStore()
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

        return socket
    }

    function disconnect() {
        socket?.disconnect()
        socket = null
    }

    onBeforeUnmount(() => disconnect())

    return { connect, disconnect, connected }
}
