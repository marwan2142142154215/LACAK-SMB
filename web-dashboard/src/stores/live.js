import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const HEARTBEAT_INTERVAL_MS = 30_000
// Kamera dicek tiap beberapa detik selama siaran; baru dianggap mati kalau
// mati lebih lama dari batas ini (menyalakan ulang kamera butuh ~1 detik).
const CAMERA_CHECK_MS = 2_000
const CAMERA_DEAD_AFTER_MS = 5_000
// Tanpa keyboard/mouse selama ini (atau layar komputer terkunci) -> IDLE.
const IDLE_THRESHOLD_MS = 5 * 60_000

// Nilai Track.Source & ConnectionState.Connected di livekit-client --
// ditulis langsung supaya store ini (dipakai AppShell di SEMUA halaman)
// tidak ikut memuat livekit-client (~500 kB). Library-nya baru di-import
// dinamis di connect(), saat staf benar-benar membuka siaran.
export const CAMERA_SOURCE = 'camera'
export const SCREEN_SOURCE = 'screen_share'
export const MICROPHONE_SOURCE = 'microphone'
const CONNECTED = 'connected'

// Pilihan bisu mikrofon staf diingat lintas muat ulang -- staf yang sudah
// membisukan diri tidak boleh tiba-tiba bersuara lagi setelah refresh.
const MIC_MUTED_KEY = 'lacak_live_mic_muted'

function readMicMuted() {
    try {
        return localStorage.getItem(MIC_MUTED_KEY) === '1'
    } catch {
        return false
    }
}

function writeMicMuted(muted) {
    try {
        localStorage.setItem(MIC_MUTED_KEY, muted ? '1' : '0')
    } catch {
        // mode privat / penyimpanan diblokir -- cukup berlaku sampai reload
    }
}

/** Mikrofon peserta: 'on' (tersiar), 'muted' (dibisukan staf), 'none' (tidak ada mikrofon). */
export function micStateOf(participant) {
    const publication = participant?.getTrackPublication(MICROPHONE_SOURCE)
    if (!publication) return 'none'
    return publication.isMuted ? 'muted' : 'on'
}

/** Browser ini bisa berbagi layar? (HP: tidak -- iOS/Android browser tidak punya getDisplayMedia.) */
export const canShareScreen = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia

// Layar kerja: SELURUH layar (bukan satu jendela/tab), tanpa audio sistem
// (suara staf lewat mikrofon, track tersendiri). Teks harus
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
let cameraCheckTimer = null
let cameraDeadSince = null
let reportTimer = null
let wakeLock = null
let idleDetector = null
let idleAbort = null
// Identity peserta yang suaranya diputar & daftar yang sedang tampil -- dasar
// subscribe/unsubscribe track (lihat applySubscriptions).
let visibleIdentities = new Set()
// Elemen <audio> untuk tiap track mikrofon yang di-subscribe; tidak tampil.
let audioContainer = null

function playAudioTrack(track) {
    if (typeof document === 'undefined') return
    if (!audioContainer) {
        audioContainer = document.createElement('div')
        audioContainer.hidden = true
        document.body.appendChild(audioContainer)
    }
    audioContainer.appendChild(track.attach())
}

function stopAudioTrack(track) {
    track.detach().forEach((element) => element.remove())
}

export const useLiveStore = defineStore('live', () => {
    const auth = useAuthStore()
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
    // Siaran ini dimulai dengan layar (komputer) -> layar WAJIB tetap dibagikan.
    // Siaran dari HP (kamera saja) tidak terkena aturan ini.
    const screenRequired = ref(false)
    // Mikrofon saya dibisukan (oleh saya sendiri) / tidak bisa dipakai.
    const micMuted = ref(readMicMuted())
    const micProblem = ref(null)
    // Kamera benar-benar mengirim gambar? false = kamera mati lebih dari
    // CAMERA_DEAD_AFTER_MS -> dashboard dikunci (CameraLock) sampai menyala lagi.
    const cameraLive = ref(true)
    // Penonton: identity staf yang suaranya sedang didengarkan. Default
    // kosong -- puluhan mikrofon sekaligus hanya jadi keributan, dan tidak
    // ada audio yang diunduh sebelum penonton memilih mendengarkan.
    const listening = ref([])

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

    /** Mikrofon saya: 'on' | 'muted' | 'none' (tidak ada / ditolak). */
    const localMicState = computed(() => {
        revision.value
        return ownRoom ? micStateOf(ownRoom.localParticipant) : 'none'
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
            .on(RoomEvent.TrackSubscribed, (track) => {
                if (track.kind === 'audio') playAudioTrack(track)
                bump()
            })
            .on(RoomEvent.TrackUnsubscribed, (track) => {
                if (track.kind === 'audio') stopAudioTrack(track)
                bump()
            })
            .on(RoomEvent.ConnectionQualityChanged, bump)
            .on(RoomEvent.ActiveSpeakersChanged, bump)
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

    /**
     * Video: hanya peserta yang sedang tampil. Suara: hanya yang dipilih untuk
     * didengarkan (tetap terdengar walau ubinnya tergulir ke halaman lain).
     */
    function applySubscriptions() {
        const listened = new Set(listening.value)
        for (const room of rooms.values()) {
            if (room.state !== CONNECTED) continue
            for (const participant of room.remoteParticipants.values()) {
                const visible = visibleIdentities.has(participant.identity)
                participant.getTrackPublication(CAMERA_SOURCE)?.setSubscribed(visible)
                participant.getTrackPublication(SCREEN_SOURCE)?.setSubscribed(visible)
                participant.getTrackPublication(MICROPHONE_SOURCE)?.setSubscribed(listened.has(participant.identity))
            }
        }
    }

    /** Nyalakan/bisukan suara satu staf -- panggil dari klik (izin autoplay). */
    function toggleListen(identity) {
        listening.value = listening.value.includes(identity)
            ? listening.value.filter((id) => id !== identity)
            : [...listening.value, identity]
        for (const room of rooms.values()) room.startAudio().catch(() => {})
        applySubscriptions()
    }

    function muteAll() {
        listening.value = []
        applySubscriptions()
    }

    function resetBroadcastState() {
        mode.value = 'idle'
        cameraProblem.value = null
        broadcastStartedAt.value = null
        onBreak.value = false
        isIdle.value = false
        myStatus.value = null
        screenRequired.value = false
        micProblem.value = null
        cameraLive.value = true
        cameraDeadSince = null
    }

    async function disconnect() {
        stopHeartbeat()
        stopIdleWatch()
        releaseWakeLock()
        const current = [...rooms.values()]
        rooms.clear()
        ownRoom = null
        watchedSiteIds.value = []
        listening.value = []
        visibleIdentities = new Set()
        audioContainer?.replaceChildren()
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
        if (participant !== ownRoom?.localParticipant) return bump() // mis. mikrofon staf lain dibisukan
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

    // Kamera bisa tetap 'live' tapi tidak mengirim gambar sama sekali --
    // browser hanya menandainya muted (mis. direbut aplikasi lain, driver
    // tersendat). LiveKit tidak menganggapnya mati, jadi cek sendiri.
    const cameraIsLive = () =>
        trackIsLive(CAMERA_SOURCE) && !ownRoom.localParticipant.getTrackPublication(CAMERA_SOURCE).track.mediaStreamTrack.muted

    /**
     * Panggil langsung dari klik tombol: dialog pilih layar & izin deteksi
     * idle butuh user gesture. Di komputer, layar dibagikan SEBELUM kamera
     * menyala -- mulai kerja = layar + kamera langsung tersiar.
     */
    async function startWork({ resuming = false } = {}) {
        connecting.value = true
        cameraProblem.value = null
        let screenTrack = null
        // Melanjutkan otomatis setelah reload tidak punya klik user, dan
        // browser menolak dialog pilih layar tanpa klik -- layar dibagikan
        // lewat kunci "Layar wajib dibagikan" (ScreenShareLock) sesudahnya.
        try {
            if (canShareScreen && !resuming) screenTrack = await captureEntireScreen()
        } catch (err) {
            connecting.value = false
            throw err
        }
        const idlePermission = resuming ? idlePermissionAlreadyGranted() : requestIdlePermission()
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
            // Siaran baru = mikrofon menyala; melanjutkan setelah reload = ikut
            // pilihan bisu terakhir staf.
            if (!resuming) setMicMutedPref(false)
            await enableMicrophone()
            screenRequired.value = canShareScreen
            mode.value = 'broadcasting'
            broadcastStartedAt.value = session.started_at ?? new Date().toISOString()
            onBreak.value = !!session.on_break
            startHeartbeat()
            acquireWakeLock()
            startIdleWatch(await idlePermission)
            await sendHeartbeat()
        } catch (err) {
            // Kamera ditolak / koneksi gagal -- jangan biarkan sesi kerja
            // tercatat aktif padahal tidak ada video yang tersiar. Kecuali saat
            // melanjutkan otomatis: sesi dibiarkan, staf masih bisa menekan
            // "Lanjutkan siaran" (atau sesi ditutup sendiri oleh timeout).
            screenTrack?.stop()
            if (!resuming) await api.post('/live/sessions/end').catch(() => {})
            await disconnect()
            throw err
        } finally {
            connecting.value = false
        }
    }

    /**
     * Setelah halaman dimuat ulang (refresh, buka tab lagi), sambungkan lagi
     * siaran yang sesi kerjanya masih terbuka di server -- staf tidak perlu
     * menekan apa pun. Dipanggil AppShell & LiveView; dijalankan sekali per
     * pemuatan halaman (pemanggil berikutnya menunggu hasil yang sama).
     *
     * @returns {Promise<{ resumed: boolean, error?: Error }>}
     */
    let resumeTask = null
    let resumeUserId = null
    function resumeIfBroadcasting() {
        // Per user: logout lalu login akun lain tanpa reload harus dicek ulang.
        if (resumeUserId !== auth.user?.id) resumeTask = null
        resumeUserId = auth.user?.id
        resumeTask ??= (async () => {
            if (mode.value !== 'idle' || !auth.hasPermission('live.broadcast') || !auth.user?.organization_id) {
                return { resumed: false }
            }
            try {
                const response = await api.get('/live/sessions', { params: { organization_id: auth.user.organization_id } })
                if (!response.data.data.my_session) return { resumed: false }
                await startWork({ resuming: true })
                return { resumed: true }
            } catch (error) {
                return { resumed: false, error }
            }
        })()
        return resumeTask
    }

    function setMicMutedPref(muted) {
        micMuted.value = muted
        writeMicMuted(muted)
    }

    /**
     * Terbitkan mikrofon (dibisukan kalau staf memilih bisu). Gagal (tidak ada
     * mikrofon, izin ditolak) tidak menghentikan siaran -- kamera & layar
     * tetap jalan, staf diberi tahu lewat micProblem.
     */
    async function enableMicrophone() {
        try {
            if (ownRoom.localParticipant.getTrackPublication(MICROPHONE_SOURCE)) {
                await ownRoom.localParticipant.setMicrophoneEnabled(!micMuted.value)
            } else {
                // Track dibisukan SEBELUM diterbitkan -- staf yang memilih bisu
                // tidak pernah tersiar suaranya, sesaat pun.
                const { createLocalAudioTrack } = await import('livekit-client')
                const track = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true })
                if (micMuted.value) await track.mute()
                await ownRoom.localParticipant.publishTrack(track)
            }
            micProblem.value = null
        } catch (err) {
            micProblem.value =
                err.name === 'NotAllowedError'
                    ? 'Izin mikrofon ditolak. Izinkan mikrofon di pengaturan situs browser, lalu tekan Nyalakan mikrofon.'
                    : 'Mikrofon tidak ditemukan atau sedang dipakai aplikasi lain. Siaran tetap jalan tanpa suara.'
        }
        bump()
    }

    /** Bisukan / nyalakan mikrofon saya tanpa memutus siaran. */
    async function setMicrophone(enabled) {
        if (!ownRoom || mode.value !== 'broadcasting') return
        setMicMutedPref(!enabled)
        if (enabled) {
            await enableMicrophone()
            if (micProblem.value) throw new Error(micProblem.value)
        } else {
            await ownRoom.localParticipant.setMicrophoneEnabled(false)
            bump()
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
        cameraCheckTimer = setInterval(checkCamera, CAMERA_CHECK_MS)
    }

    function stopHeartbeat() {
        clearInterval(heartbeatTimer)
        clearInterval(cameraCheckTimer)
        clearTimeout(reportTimer)
        heartbeatTimer = null
        cameraCheckTimer = null
        reportTimer = null
    }

    function checkCamera() {
        if (mode.value !== 'broadcasting') return
        if (cameraIsLive()) {
            cameraDeadSince = null
            if (!cameraLive.value) {
                cameraLive.value = true
                cameraProblem.value = null
                scheduleReport()
            }
            return
        }
        cameraDeadSince ??= Date.now()
        if (cameraLive.value && Date.now() - cameraDeadSince >= CAMERA_DEAD_AFTER_MS) {
            cameraLive.value = false
            scheduleReport()
        }
    }

    // IDLE pakai Idle Detection API (Chrome/Edge desktop): mendeteksi tidak
    // ada input di SELURUH komputer, bukan cuma di tab ini, dan layar
    // terkunci. Browser lain tidak mendukung -> status IDLE tidak dipakai.
    // Izin deteksi idle yang sudah diberikan sebelumnya tetap berlaku setelah
    // reload, jadi tidak perlu klik untuk memintanya lagi.
    async function idlePermissionAlreadyGranted() {
        if (!('IdleDetector' in window)) return false
        try {
            return (await navigator.permissions.query({ name: 'idle-detection' })).state === 'granted'
        } catch {
            return false
        }
    }

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
        visibleIdentities = new Set(identities)
        applySubscriptions()
    }

    return {
        mode,
        organizationId,
        cameraProblem,
        broadcastStartedAt,
        onBreak,
        isIdle,
        myStatus,
        screenRequired,
        micMuted,
        micProblem,
        cameraLive,
        localMicState,
        listening,
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
        resumeIfBroadcasting,
        endWork,
        restartCamera,
        setScreenShare,
        setBreak,
        localCameraSettings,
        disconnect,
        setVisibleParticipants,
        setMicrophone,
        toggleListen,
        muteAll,
    }
})
