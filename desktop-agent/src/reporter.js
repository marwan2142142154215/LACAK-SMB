'use strict'

const { io } = require('socket.io-client')

/**
 * Pelapor lokasi ke realtime-gateway namespace /ops, event `staff:location`
 * (lihat realtime-gateway/app/services/StaffLocationHub.ts). Token login dipakai
 * di handshake, sama dengan dashboard web. Payload:
 *   { latitude, longitude, accuracy, source, isMock, client: 'desktop' }
 * Server memvalidasi, membatasi laju (~15 dtk), menghitung confidence, menyimpan,
 * lalu menyiarkan ke pengawas (radar.view). Agen hanya mengirim.
 */
class Reporter {
    constructor(config) {
        this.config = config
        this.socket = null
        this.onExpired = () => {}
    }

    connect() {
        const { gatewayUrl } = this.config.settings()
        const token = this.config.getToken()
        if (!token) return

        this.socket = io(`${gatewayUrl}/ops`, {
            transports: ['websocket'],
            auth: { token },
            reconnection: true,
        })

        // Sesi berakhir di server (idle timeout / login di perangkat lain):
        // beri tahu main supaya minta login ulang.
        this.socket.on('session:expired', () => this.onExpired())
    }

    /**
     * Kirim satu fix. `fix` dari navigator.geolocation (renderer):
     * { latitude, longitude, accuracy }. Sumber diperkirakan dari akurasi
     * (desktop tak memberi tahu GPS vs WiFi); server yang menilai confidence.
     */
    sendLocation(fix) {
        if (!this.socket || !fix) return
        const accuracy = Number.isFinite(fix.accuracy) ? fix.accuracy : null
        // Akurasi halus = kemungkinan WiFi/GPS; kasar = network. Keduanya BUKAN IP,
        // jadi tetap tahan-VPN; penilaian akhir high/low ada di server.
        const source = accuracy != null && accuracy <= 100 ? 'wifi' : 'network'
        this.socket.emit('staff:location', {
            latitude: fix.latitude,
            longitude: fix.longitude,
            accuracy,
            source,
            isMock: false,
            client: 'desktop',
        })
    }

    disconnect() {
        this.socket?.disconnect()
        this.socket = null
    }
}

module.exports = { Reporter }
