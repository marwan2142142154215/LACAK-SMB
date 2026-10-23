import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import api from '@/lib/api'

const HEARTBEAT_INTERVAL_MS = 30_000

// Nilai Track.Source.Camera & ConnectionState.Connected di livekit-client --
// ditulis langsung supaya store ini (dipakai AppShell di SEMUA halaman)
// tidak ikut memuat livekit-client (~500 kB). Library-nya baru di-import
// dinamis di connect(), saat staf benar-benar membuka siaran.
export const CAMERA_SOURCE = 'camera'
const CONNECTED = 'connected'

/**
 * Koneksi Live Kerja (LiveKit). SENGAJA disimpan di store, bukan di
 * LiveView.vue -- supaya siaran kamera tetap jalan saat staf pindah ke
 * halaman lain di dashboard (Radar, Device, dst). AppShell menampilkan
 * indikator LIVE selama `isBroadcasting`.
 *
 * Objek Room LiveKit disimpan di variabel modul (bukan ref) karena isinya
 * kelas yang berubah sendiri dari dalam -- dibungkus reaktif Vue malah bikin
 * proxy berat ke ribuan properti internal. Komponen me-render ulang lewat
 * `revision`, yang dinaikkan setiap kali ada event peserta/track.
 */
let room = null
let heartbeatTimer = null
let wakeLock = null

export const useLiveStore = defineStore('live', () => {
    const mode = ref('idle') // idle | watching | broadcasting
    const organizationId = ref(null)
    const connecting = ref(false)
    const revision = ref(0)
    // Pesan untuk staf kalau kamera berhenti mengirim gambar di tengah siaran
    // (dipakai aplikasi lain, izin dicabut, kabel kamera USB lepas, dst).
    const cameraProblem = ref(null)

    const isBroadcasting = computed(() => mode.value === 'broadcasting')

    const remoteParticipants = computed(() => {
        revision.value // dependensi reaktif, lihat catatan di atas
        if (!room) return []
        return [...room.remoteParticipants.values()]
            .filter((p) => p.getTrackPublication(CAMERA_SOURCE))
            .sort((a, b) => (a.name || a.identity).localeCompare(b.name || b.identity))
    })

    const localCameraTrack = computed(() => {
        revision.value
        return room?.localParticipant.getTrackPublication(CAMERA_SOURCE)?.track ?? null
    })

    function bump() {
        revision.value++
    }

    async function connect(livekitUrl, token) {
        await disconnect()

        const { Room, RoomEvent, VideoPresets } = await import('livekit-client')
        room = new Room({
            // adaptiveStream: kualitas video tiap peserta otomatis
            // mengikuti ukuran elemen <video> & dijeda saat tidak terlihat
            // -- wajib untuk grid >50 staf supaya kuota/baterai tidak habis.
            adaptiveStream: true,
            // dynacast: pengirim berhenti meng-encode layer resolusi yang
            // tidak ada satu pun penonton yang memintanya.
            dynacast: true,
            // facingMode user: di HP pakai kamera depan (wajah staf), bukan belakang.
            videoCaptureDefaults: { resolution: VideoPresets.h540.resolution, facingMode: 'user' },
            publishDefaults: {
                simulcast: true,
                videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
            },
        })

        room.on(RoomEvent.ParticipantConnected, bump)
            .on(RoomEvent.ParticipantDisconnected, bump)
            .on(RoomEvent.TrackPublished, bump)
            .on(RoomEvent.TrackUnpublished, bump)
            .on(RoomEvent.TrackSubscribed, bump)
            .on(RoomEvent.TrackUnsubscribed, bump)
            .on(RoomEvent.LocalTrackPublished, bump)
            .on(RoomEvent.LocalTrackUnpublished, bump)
            .on(RoomEvent.TrackMuted, handleLocalCameraStopped)
            .on(RoomEvent.Disconnected, handleDisconnected)

        // autoSubscribe: false -- LiveView yang memilih peserta mana yang
        // di-subscribe (hanya yang tampil di halaman grid saat ini), bukan
        // langsung menerima video semua staf se-site sekaligus.
        await room.connect(livekitUrl, token, { autoSubscribe: false })
        bump()
    }

    async function disconnect() {
        stopHeartbeat()
        releaseWakeLock()
        if (room) {
            const current = room
            room = null
            current.off('disconnected', handleDisconnected)
            await current.disconnect()
        }
        mode.value = 'idle'
        cameraProblem.value = null
        bump()
    }

    function handleDisconnected() {
        // Diputus dari sisi server (sesi ditutup timeout, staf dikeluarkan)
        // atau koneksi gagal total setelah LiveKit menyerah reconnect.
        room = null
        stopHeartbeat()
        releaseWakeLock()
        mode.value = 'idle'
        cameraProblem.value = null
        bump()
    }

    async function watchSite(siteId) {
        connecting.value = true
        try {
            const response = await api.post('/live/watch-token', { organization_id: siteId })
            const { livekit_url, token } = response.data.data
            await connect(livekit_url, token)
            organizationId.value = siteId
            mode.value = 'watching'
        } finally {
            connecting.value = false
        }
    }

    // LiveKit membisukan track kamera lokal sendiri kalau kamera berhenti
    // (track 'ended' lalu gagal dinyalakan ulang) -- siaran tetap tercatat
    // aktif tapi tanpa gambar, jadi beri tahu staf dengan jelas.
    function handleLocalCameraStopped(publication, participant) {
        if (participant !== room?.localParticipant || publication.source !== CAMERA_SOURCE) return
        if (mode.value !== 'broadcasting') return
        cameraProblem.value = 'Kamera berhenti mengirim gambar. Tutup aplikasi lain yang memakai kamera, lalu tekan Nyalakan ulang kamera.'
        bump()
    }

    function cameraIsLive() {
        const track = room?.localParticipant.getTrackPublication(CAMERA_SOURCE)?.track
        return !!track && !track.isMuted && track.mediaStreamTrack?.readyState === 'live'
    }

    async function startWork() {
        connecting.value = true
        cameraProblem.value = null
        try {
            const response = await api.post('/live/sessions/start')
            const { livekit_url, token, session } = response.data.data
            await connect(livekit_url, token)
            organizationId.value = session.organization_id
            await room.localParticipant.setCameraEnabled(true)
            // Kamera bisa "berhasil" dibuka lalu langsung berhenti (mis. sedang
            // dipakai aplikasi lain) -- jangan anggap siaran jalan tanpa gambar.
            await new Promise((resolve) => setTimeout(resolve, 800))
            if (!cameraIsLive()) {
                const error = new Error(
                    'Kamera menyala sebentar lalu berhenti. Tutup aplikasi lain yang memakai kamera (Zoom, Teams, tab lain), lalu coba lagi.',
                )
                error.name = 'CameraNotLive'
                throw error
            }
            mode.value = 'broadcasting'
            startHeartbeat()
            acquireWakeLock()
        } catch (err) {
            // Kamera ditolak / koneksi gagal -- jangan biarkan sesi kerja
            // tercatat aktif padahal tidak ada video yang tersiar.
            await api.post('/live/sessions/end').catch(() => {})
            await disconnect()
            throw err
        } finally {
            connecting.value = false
        }
    }

    /** Matikan lalu nyalakan lagi kamera tanpa memutus siaran. */
    async function restartCamera() {
        if (!room || mode.value !== 'broadcasting') return
        await room.localParticipant.setCameraEnabled(false)
        await room.localParticipant.setCameraEnabled(true)
        await new Promise((resolve) => setTimeout(resolve, 800))
        cameraProblem.value = cameraIsLive()
            ? null
            : 'Kamera masih belum mengirim gambar. Periksa izin kamera di browser dan pastikan tidak dipakai aplikasi lain.'
        bump()
    }

    async function endWork() {
        connecting.value = true
        try {
            await api.post('/live/sessions/end').catch((err) => {
                if (err.response?.status !== 404) throw err
            })
            await disconnect()
        } finally {
            connecting.value = false
        }
    }

    function startHeartbeat() {
        stopHeartbeat()
        heartbeatTimer = setInterval(async () => {
            try {
                await api.post('/live/sessions/heartbeat')
            } catch (err) {
                // 404 = server sudah menutup sesi (mis. jaringan sempat putus
                // lebih lama dari batas timeout) -- berhenti menyiarkan.
                if (err.response?.status === 404) await disconnect()
            }
        }, HEARTBEAT_INTERVAL_MS)
    }

    function stopHeartbeat() {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
    }

    // Layar HP yang mati otomatis ikut memutus kamera di browser -- selama
    // siaran, minta layar tetap menyala (diabaikan kalau browser tidak
    // mendukung Wake Lock API).
    async function acquireWakeLock() {
        try {
            wakeLock = await navigator.wakeLock?.request('screen')
        } catch {
            wakeLock = null
        }
    }

    function releaseWakeLock() {
        wakeLock?.release().catch(() => {})
        wakeLock = null
    }

    if (typeof document !== 'undefined') {
        // Wake lock dilepas otomatis oleh browser saat tab disembunyikan --
        // minta lagi begitu staf kembali ke aplikasi.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && mode.value === 'broadcasting') acquireWakeLock()
        })
    }

    /** Subscribe hanya ke peserta yang sedang tampil, unsubscribe sisanya. */
    function setVisibleParticipants(identities) {
        if (!room || room.state !== CONNECTED) return
        const visible = new Set(identities)
        for (const participant of room.remoteParticipants.values()) {
            participant.getTrackPublication(CAMERA_SOURCE)?.setSubscribed(visible.has(participant.identity))
        }
    }

    return {
        mode,
        organizationId,
        cameraProblem,
        connecting,
        isBroadcasting,
        remoteParticipants,
        localCameraTrack,
        watchSite,
        startWork,
        endWork,
        restartCamera,
        disconnect,
        setVisibleParticipants,
    }
})
