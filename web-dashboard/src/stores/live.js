import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import api from '@/lib/api'

const HEARTBEAT_INTERVAL_MS = 30_000
// Tanpa keyboard/mouse selama ini (atau layar komputer terkunci) -> IDLE.
const IDLE_THRESHOLD_MS = 5 * 60_000

// Nilai Track.Source & ConnectionState.Connected di livekit-client --
// ditulis langsung supaya store ini (dipakai AppShell di SEMUA halaman)
// tidak ikut memuat livekit-client (~500 kB). Library-nya baru di-import
// dinamis di connect(), saat staf benar-benar membuka siaran.
export const CAMERA_SOURCE = 'camera'
export const SCREEN_SOURCE = 'screen_share'
const CONNECTED = 'connected'

/** Browser ini bisa berbagi layar? (HP: tidak -- iOS/Android browser tidak punya getDisplayMedia.) */
export const canShareScreen = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia

// Layar kerja: SELURUH layar (bukan satu jendela/tab), tanpa audio. Teks harus
// terbaca -> 1080p, cukup 15 fps. displaySurface 'monitor' membuat dialog
// Chrome/Edge langsung terbuka di tab "Entire screen"; staf tetap harus
// menekan Share sekali -- browser tidak mengizinkan situs melewatinya.
const SCREEN_CAPTURE_OPTIONS = {
    audio: false,
    video: { displaySurface: 'monitor' },
    contentHint: 'detail',
    resolution: { width: 1920, height: 1080, frameRate: 15 },
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
}

/**
 * Minta staf memilih seluruh layar. Kalau yang dipilih ternyata satu jendela
 * atau tab, ditolak -- yang dipantau harus layar kerja utuh.
 */
async function captureEntireScreen() {
    const { createLocalScreenTracks } = await import('livekit-client')
    let tracks
    try {
        tracks = await createLocalScreenTracks(SCREEN_CAPTURE_OPTIONS)
    } catch (err) {
        const error = new Error(
            err.name === 'NotAllowedError'
                ? 'Berbagi layar dibatalkan. Pilih tab "Entire screen" / "Seluruh layar", lalu tekan Share.'
                : `Layar tidak bisa dibagikan: ${err.message}`,
        )
        error.name = 'ScreenShareFailed'
        throw error
    }
    const video = tracks.find((track) => track.kind === 'video')
    tracks.filter((track) => track !== video).forEach((track) => track.stop())
    // Firefox lama tidak melaporkan displaySurface -- kalau kosong, diterima.
    const surface = video?.mediaStreamTrack.getSettings().displaySurface
    if (!video || (surface && surface !== 'monitor')) {
        video?.stop()
        const error = new Error(
            'Yang dibagikan harus seluruh layar, bukan satu jendela atau tab. Pilih tab "Entire screen" / "Seluruh layar".',
        )
        error.name = 'ScreenShareFailed'
        throw error
    }
    return video
}

/**
 * Koneksi Live Kerja (LiveKit). SENGAJA disimpan di store, bukan di
 * LiveView.vue -- supaya siaran tetap jalan saat staf pindah ke halaman lain
 * di dashboard (Radar, Device, dst). AppShell menampilkan indikator LIVE
 * selama `isBroadcasting`.
 *
 * Objek Room LiveKit disimpan di variabel modul (bukan ref) karena isinya
 * kelas yang berubah sendiri dari dalam -- dibungkus reaktif Vue malah bikin
 * proxy berat ke ribuan properti internal. Komponen me-render ulang lewat
 * `revision`, yang dinaikkan setiap kali ada event peserta/track.
 *
 * Status kerja (kamera/layar menyala, istirahat, idle) dilaporkan ke backend
 * lewat heartbeat -- backend yang menghitung status & mencatat log kerja.
 *
 * Satu room LiveKit = satu site. Penonton multi-site (super_admin, admin,
 * leader) bisa membuka "Semua site" -- satu koneksi per site, di `rooms`.
 * Staf yang menyiarkan hanya terhubung ke room site-nya sendiri (`ownRoom`).
 */
const rooms = new Map() // siteId -> Room
let ownRoom = null
let heartbeatTimer = null
let reportTimer = null
let wakeLock = null
let idleDetector = null
let idleAbort = null

export const useLiveStore = defineStore('live', () => {
    const mode = ref('idle') // idle | watching | broadcasting
    const organizationId = ref(null)
    const connecting = ref(false)
    const revision = ref(0)
    // Pesan untuk staf kalau kamera berhenti mengirim gambar di tengah siaran
    // (dipakai aplikasi lain, izin dicabut, kabel kamera USB lepas, dst).
    const cameraProblem = ref(null)
    // Awal sesi kerja (dari server) -- dasar durasi siaran di monitor sendiri.
    const broadcastStartedAt = ref(null)
    const onBreak = ref(false)
    const isIdle = ref(false)
    // Status kerja saya menurut server (working, screen_off, break, ...).
    const myStatus = ref(null)

    const isBroadcasting = computed(() => mode.value === 'broadcasting')

    const watchedSiteIds = ref([])

    const remoteParticipants = computed(() => {
        revision.value // dependensi reaktif, lihat catatan di atas
        return [...rooms.values()]
            .flatMap((room) => [...room.remoteParticipants.values()])
            .filter((p) => p.getTrackPublication(CAMERA_SOURCE) || p.getTrackPublication(SCREEN_SOURCE))
            .sort((a, b) => (a.name || a.identity).localeCompare(b.name || b.identity))
    })

    /** identity peserta -> id site-nya (untuk label site di mode "Semua site"). */
    const participantSites = computed(() => {
        revision.value
        const sites = {}
        for (const [siteId, room] of rooms) {
            for (const participant of room.remoteParticipants.values()) sites[participant.identity] = siteId
        }
        return sites
    })

    const localCameraTrack = computed(() => {
        revision.value
        return ownRoom?.localParticipant.getTrackPublication(CAMERA_SOURCE)?.track ?? null
    })

    const localScreenTrack = computed(() => {
        revision.value
        return ownRoom?.localParticipant.getTrackPublication(SCREEN_SOURCE)?.track ?? null
    })

    function bump() {
        revision.value++
    }

    /** Sambung ke room satu site dan simpan di `rooms`. */
    async function connect(livekitUrl, token, siteId) {
        const { Room, RoomEvent, ScreenSharePresets, VideoPresets } = await import('livekit-client')
        const room = new Room({
            // adaptiveStream: kualitas video tiap peserta otomatis
            // mengikuti ukuran elemen <video> & dijeda saat tidak terlihat
            // -- wajib untuk grid >50 staf supaya kuota/baterai tidak habis.
            // pixelDensity 'screen': ukuran elemen dikali kepadatan piksel layar,
            // jadi layar HP/laptop resolusi tinggi meminta layer yang lebih tajam.
            // Ditambah simulcast di bawah, inilah "kualitas otomatis menurut
            // koneksi": saat bandwidth penonton turun, server LiveKit
            // mengirim layer yang lebih rendah tanpa diminta.
            adaptiveStream: { pixelDensity: 'screen' },
            // dynacast: pengirim berhenti meng-encode layer resolusi yang
            // tidak ada satu pun penonton yang memintanya.
            dynacast: true,
            // 720p untuk tampilan besar; facingMode user: di HP pakai kamera
            // depan (wajah staf), bukan belakang.
            videoCaptureDefaults: { resolution: VideoPresets.h720.resolution, facingMode: 'user' },
            publishDefaults: {
                simulcast: true,
                // 720p dengan bitrate lebih longgar dari preset (1,7 Mbps) supaya
                // detail meja kerja tidak pecah jadi kotak-kotak.
                videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
                // Layer bawah untuk ubin kecil/jaringan lemah; penonton menerima
                // layer sesuai ukuran ubinnya (dynacast mematikan yang tak diminta).
                videoSimulcastLayers: [VideoPresets.h360, VideoPresets.h540],
                // Layar kerja: teks harus terbaca -> 1080p, cukup 15 fps.
                screenShareEncoding: ScreenSharePresets.h1080fps15.encoding,
                screenShareSimulcastLayers: [ScreenSharePresets.h360fps3, ScreenSharePresets.h720fps5],
                // Saat bandwidth/CPU pas-pasan, turunkan frame rate -- bukan
                // resolusi. Untuk memantau kerja, gambar tajam lebih penting
                // daripada gerakan mulus.
                degradationPreference: 'maintain-resolution',
            },
        })

        room.on(RoomEvent.ParticipantConnected, bump)
            .on(RoomEvent.ParticipantDisconnected, bump)
            .on(RoomEvent.TrackPublished, bump)
            .on(RoomEvent.TrackUnpublished, bump)
            .on(RoomEvent.TrackSubscribed, bump)
            .on(RoomEvent.TrackUnsubscribed, bump)
            .on(RoomEvent.ConnectionQualityChanged, bump)
            .on(RoomEvent.LocalTrackPublished, handleLocalTracksChanged)
            .on(RoomEvent.LocalTrackUnpublished, handleLocalTracksChanged)
            .on(RoomEvent.TrackMuted, handleLocalCameraStopped)
            .on(RoomEvent.TrackUnmuted, handleLocalTracksChanged)
            .on(RoomEvent.Disconnected, () => handleRoomDisconnected(siteId, room))

        // autoSubscribe: false -- LiveView yang memilih peserta mana yang
        // di-subscribe (hanya yang tampil di halaman grid saat ini), bukan
        // langsung menerima video semua staf se-site sekaligus.
        await room.connect(livekitUrl, token, { autoSubscribe: false })
        rooms.set(siteId, room)
        bump()
        return room
    }

    function resetBroadcastState() {
        mode.value = 'idle'
        cameraProblem.value = null
        broadcastStartedAt.value = null
        onBreak.value = false
        isIdle.value = false
        myStatus.value = null
    }

    async function disconnect() {
        stopHeartbeat()
        stopIdleWatch()
        releaseWakeLock()
        const current = [...rooms.values()]
        rooms.clear()
        ownRoom = null
        watchedSiteIds.value = []
        // removeAllListeners: disconnect() yang kita minta sendiri bukan "putus".
        await Promise.all(current.map((room) => room.removeAllListeners().disconnect()))
        resetBroadcastState()
        bump()
    }

    // Diputus dari sisi server (sesi ditutup timeout, staf dikeluarkan) atau
    // koneksi gagal total setelah LiveKit menyerah reconnect.
    function handleRoomDisconnected(siteId, room) {
        if (rooms.get(siteId) === room) rooms.delete(siteId)
        watchedSiteIds.value = watchedSiteIds.value.filter((id) => rooms.has(id))
        if (room === ownRoom || rooms.size === 0) {
            ownRoom = null
            stopHeartbeat()
            stopIdleWatch()
            releaseWakeLock()
            resetBroadcastState()
        }
        bump()
    }

    const watchSite = (siteId) => watchSites([siteId])

    /**
     * Tonton satu atau beberapa site sekaligus. Site yang gagal tersambung
     * dilewati; error baru dilempar kalau SEMUA site gagal.
     */
    async function watchSites(siteIds) {
        connecting.value = true
        try {
            await disconnect()
            const results = await Promise.allSettled(
                siteIds.map(async (siteId) => {
                    const response = await api.post('/live/watch-token', { organization_id: siteId })
                    const { livekit_url, token } = response.data.data
                    await connect(livekit_url, token, siteId)
                }),
            )
            if (!rooms.size) throw results.find((result) => result.status === 'rejected')?.reason ?? new Error('Tidak ada site')
            watchedSiteIds.value = siteIds.filter((id) => rooms.has(id))
            organizationId.value = siteIds.length === 1 ? siteIds[0] : null
            mode.value = 'watching'
        } finally {
            connecting.value = false
        }
    }

    // Kamera/layar menyala atau mati -> laporkan segera (log kerja mencatat
    // "Camera run", "Screen stop", dst. dengan jam yang tepat).
    function handleLocalTracksChanged() {
        bump()
        if (mode.value === 'broadcasting') scheduleReport()
    }

    // LiveKit membisukan track kamera lokal sendiri kalau kamera berhenti
    // (track 'ended' lalu gagal dinyalakan ulang) -- siaran tetap tercatat
    // aktif tapi tanpa gambar, jadi beri tahu staf dengan jelas.
    function handleLocalCameraStopped(publication, participant) {
        if (participant !== ownRoom?.localParticipant) return
        handleLocalTracksChanged()
        if (publication.source !== CAMERA_SOURCE || mode.value !== 'broadcasting') return
        // Saat staf pindah aplikasi, browser HP memang menghentikan kamera --
        // itu bukan masalah; kamera dinyalakan ulang otomatis begitu kembali.
        if (document.visibilityState === 'hidden') return
        cameraProblem.value = 'Kamera berhenti mengirim gambar. Tutup aplikasi lain yang memakai kamera, lalu tekan Nyalakan ulang kamera.'
    }

    function trackIsLive(source) {
        const track = ownRoom?.localParticipant.getTrackPublication(source)?.track
        return !!track && !track.isMuted && track.mediaStreamTrack?.readyState === 'live'
    }

    const cameraIsLive = () => trackIsLive(CAMERA_SOURCE)

    /**
     * Panggil langsung dari klik tombol: dialog pilih layar & izin deteksi
     * idle butuh user gesture. Di komputer, layar dibagikan SEBELUM kamera
     * menyala -- mulai kerja = layar + kamera langsung tersiar.
     */
    async function startWork() {
        connecting.value = true
        cameraProblem.value = null
        let screenTrack = null
        try {
            if (canShareScreen) screenTrack = await captureEntireScreen()
        } catch (err) {
            connecting.value = false
            throw err
        }
        const idlePermission = requestIdlePermission()
        try {
            const response = await api.post('/live/sessions/start')
            const { livekit_url, token, session } = response.data.data
            await disconnect()
            ownRoom = await connect(livekit_url, token, session.organization_id)
            organizationId.value = session.organization_id
            watchedSiteIds.value = [session.organization_id]
            await ownRoom.localParticipant.setCameraEnabled(true)
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
            if (screenTrack) await ownRoom.localParticipant.publishTrack(screenTrack)
            mode.value = 'broadcasting'
            broadcastStartedAt.value = session.started_at ?? new Date().toISOString()
            onBreak.value = !!session.on_break
            startHeartbeat()
            acquireWakeLock()
            startIdleWatch(await idlePermission)
            await sendHeartbeat()
        } catch (err) {
            // Kamera ditolak / koneksi gagal -- jangan biarkan sesi kerja
            // tercatat aktif padahal tidak ada video yang tersiar.
            screenTrack?.stop()
            await api.post('/live/sessions/end').catch(() => {})
            await disconnect()
            throw err
        } finally {
            connecting.value = false
        }
    }

    /** Matikan lalu nyalakan lagi kamera tanpa memutus siaran. */
    async function restartCamera() {
        if (!ownRoom || mode.value !== 'broadcasting') return
        await ownRoom.localParticipant.setCameraEnabled(false)
        await ownRoom.localParticipant.setCameraEnabled(true)
        await new Promise((resolve) => setTimeout(resolve, 800))
        cameraProblem.value = cameraIsLive()
            ? null
            : 'Kamera masih belum mengirim gambar. Periksa izin kamera di browser dan pastikan tidak dipakai aplikasi lain.'
        bump()
        scheduleReport()
    }

    /**
     * Bagikan lagi / hentikan berbagi seluruh layar di tengah siaran. Kalau
     * staf menekan "Stop sharing" milik browser, LiveKit melepas track-nya
     * sendiri dan handleLocalTracksChanged() melaporkan "Screen stop".
     */
    async function setScreenShare(enabled) {
        if (!ownRoom || mode.value !== 'broadcasting') return
        if (enabled) {
            const track = await captureEntireScreen()
            await ownRoom.localParticipant.publishTrack(track)
        } else {
            await ownRoom.localParticipant.setScreenShareEnabled(false)
        }
        handleLocalTracksChanged()
    }

    async function setBreak(enabled) {
        onBreak.value = enabled
        await sendHeartbeat()
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

    /** Resolusi & frame rate yang benar-benar dihasilkan kamera saat ini. */
    function localCameraSettings() {
        const settings = ownRoom?.localParticipant.getTrackPublication(CAMERA_SOURCE)?.track?.mediaStreamTrack?.getSettings()
        if (!settings?.width) return null
        return { width: settings.width, height: settings.height, frameRate: Math.round(settings.frameRate ?? 0) }
    }

    async function sendHeartbeat() {
        if (mode.value !== 'broadcasting') return
        try {
            const response = await api.post('/live/sessions/heartbeat', {
                camera_active: cameraIsLive(),
                screen_active: trackIsLive(SCREEN_SOURCE),
                on_break: onBreak.value,
                idle: isIdle.value,
            })
            myStatus.value = response.data.data?.status ?? null
        } catch (err) {
            // 404 = server sudah menutup sesi (mis. jaringan sempat putus
            // lebih lama dari batas timeout) -- berhenti menyiarkan.
            if (err.response?.status === 404) await disconnect()
        }
    }

    // Beberapa event bisa datang beruntun (unpublish + mute) -- satu laporan saja.
    function scheduleReport() {
        clearTimeout(reportTimer)
        reportTimer = setTimeout(sendHeartbeat, 400)
    }

    function startHeartbeat() {
        stopHeartbeat()
        heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
    }

    function stopHeartbeat() {
        clearInterval(heartbeatTimer)
        clearTimeout(reportTimer)
        heartbeatTimer = null
        reportTimer = null
    }

    // IDLE pakai Idle Detection API (Chrome/Edge desktop): mendeteksi tidak
    // ada input di SELURUH komputer, bukan cuma di tab ini, dan layar
    // terkunci. Browser lain tidak mendukung -> status IDLE tidak dipakai.
    async function requestIdlePermission() {
        if (!('IdleDetector' in window)) return false
        try {
            return (await window.IdleDetector.requestPermission()) === 'granted'
        } catch {
            return false
        }
    }

    async function startIdleWatch(granted) {
        stopIdleWatch()
        if (!granted) return
        try {
            idleAbort = new AbortController()
            idleDetector = new window.IdleDetector()
            idleDetector.addEventListener('change', () => {
                const idleNow = idleDetector.userState === 'idle' || idleDetector.screenState === 'locked'
                if (idleNow === isIdle.value) return
                isIdle.value = idleNow
                scheduleReport()
            })
            await idleDetector.start({ threshold: IDLE_THRESHOLD_MS, signal: idleAbort.signal })
        } catch {
            idleDetector = null
        }
    }

    function stopIdleWatch() {
        idleAbort?.abort()
        idleAbort = null
        idleDetector = null
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
        document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState !== 'visible' || mode.value !== 'broadcasting') return
            acquireWakeLock()
            // Browser HP menghentikan kamera selama aplikasi di latar belakang.
            // Beri LiveKit waktu memulihkannya sendiri, lalu nyalakan ulang
            // kalau masih mati -- staf tidak perlu menekan apa pun.
            await new Promise((resolve) => setTimeout(resolve, 1500))
            if (mode.value === 'broadcasting' && !cameraIsLive()) {
                await restartCamera().catch(() => {
                    cameraProblem.value = 'Kamera belum menyala lagi setelah kembali ke aplikasi. Tekan Nyalakan ulang kamera.'
                })
            }
        })
    }

    /** Subscribe hanya ke peserta yang sedang tampil (kamera + layarnya), unsubscribe sisanya. */
    function setVisibleParticipants(identities) {
        const visible = new Set(identities)
        for (const room of rooms.values()) {
            if (room.state !== CONNECTED) continue
            for (const participant of room.remoteParticipants.values()) {
                for (const source of [CAMERA_SOURCE, SCREEN_SOURCE]) {
                    participant.getTrackPublication(source)?.setSubscribed(visible.has(participant.identity))
                }
            }
        }
    }

    return {
        mode,
        organizationId,
        cameraProblem,
        broadcastStartedAt,
        onBreak,
        isIdle,
        myStatus,
        connecting,
        isBroadcasting,
        remoteParticipants,
        participantSites,
        watchedSiteIds,
        localCameraTrack,
        localScreenTrack,
        watchSite,
        watchSites,
        startWork,
        endWork,
        restartCamera,
        setScreenShare,
        setBreak,
        localCameraSettings,
        disconnect,
        setVisibleParticipants,
    }
})
