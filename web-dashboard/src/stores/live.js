import { defineStore } from 'pinia'
import { io } from 'socket.io-client'
import { computed, ref } from 'vue'

import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const HEARTBEAT_INTERVAL_MS = 30_000
// Kamera dicek tiap beberapa detik selama siaran; baru dianggap mati kalau
// mati lebih lama dari batas ini (menyalakan ulang kamera butuh ~1 detik).
const CAMERA_CHECK_MS = 2_000
const CAMERA_DEAD_AFTER_MS = 5_000
// Kamera yang masih menyala tapi di-mute browser (tidak ada gambar) baru
// dianggap mati setelah selama ini -- muted sesaat itu biasa.
const CAMERA_MUTED_AFTER_MS = 15_000
// Render ulang grid paling sering sekali per selang ini untuk event yang
// beruntun (indikator bicara, kualitas koneksi).
const BUMP_THROTTLE_MS = 250
// Jawaban gateway untuk live:state; lebih lama dari ini -> cadangan HTTP.
const SOCKET_REPORT_TIMEOUT_MS = 8_000
// Tanpa keyboard/mouse selama ini (atau layar komputer terkunci) -> IDLE.
const IDLE_THRESHOLD_MS = 5 * 60_000
// Jalur media (UDP/TCP) dicek ulang tiap selang ini -- bisa berpindah saat
// LiveKit menyambung ulang.
const TRANSPORT_CHECK_MS = 30_000
// Kamera/layar yang terlepas dari room (gagal diterbitkan ulang saat LiveKit
// menyambung ulang) diterbitkan lagi paling sering sekali per selang ini, dan
// sesudah tersambung ulang ditunda acak sampai REPUBLISH_JITTER_MS -- puluhan
// staf yang pulih bersamaan tidak menyerbu server sekaligus.
const REPUBLISH_MIN_GAP_MS = 15_000
const REPUBLISH_JITTER_MS = 5_000
// Room siaran putus total (LiveKit menyerah menyambung ulang): sambung lagi
// otomatis setelah jeda acak ini, beberapa kali dengan jeda makin panjang.
const REJOIN_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000]
const REJOIN_JITTER_MS = 10_000

// Nilai Track.Source & ConnectionState.Connected di livekit-client --
// ditulis langsung supaya store ini (dipakai AppShell di SEMUA halaman)
// tidak ikut memuat livekit-client (~500 kB). Library-nya baru di-import
// dinamis di connect(), saat staf benar-benar membuka siaran.
// Ruang Live Kerja leader (room LiveKit "leaders"): satu ruang global untuk
// semua leader, hanya ditonton leader, admin & root. Dipakai sebagai kunci
// `rooms` / watchedSiteIds di samping id site.
export const LEADERS_ROOM_KEY = 'leaders'

export const CAMERA_SOURCE = 'camera'
export const SCREEN_SOURCE = 'screen_share'
export const MICROPHONE_SOURCE = 'microphone'
const CONNECTED = 'connected'

// Pilihan bisu mikrofon staf diingat lintas muat ulang. Bawaannya BISU:
// mikrofon yang selalu menyala membuat LiveKit terus menganalisis suara
// semua staf (siapa yang bicara) -- staf menyalakannya sendiri saat perlu.
const MIC_MUTED_KEY = 'lacak_live_mic_muted'

function readMicMuted() {
    try {
        return localStorage.getItem(MIC_MUTED_KEY) !== '0'
    } catch {
        return true
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
        // Dipanggil tanpa klik di Chrome biasa -> InvalidStateError (butuh
        // gestur). Chrome kantor dengan kebijakan
        // ScreenCaptureWithoutGestureAllowedForOrigins tidak menolaknya.
        error.needsGesture = err.name === 'InvalidStateError'
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
let cameraMutedSince = null
let screenDeadSince = null
let reportTimer = null
let bumpTimer = null
let transportTimer = null
// Track layar yang sedang saya siarkan -- disimpan supaya bisa diterbitkan
// ulang tanpa dialog pilih layar kalau terlepas saat LiveKit menyambung ulang.
let ownScreenTrack = null
let republishing = false
let lastRepublishAt = 0
let rejoinTimer = null
let rejoinAttempt = 0
// Socket Live Kerja ke gateway (lihat ensureLiveSocket).
let liveSocket = null
let liveSocketToken = null
let liveWatchIds = []
const liveStatusListeners = new Set()
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
    // Sama untuk layar: false = layar tidak terkirim lebih dari CAMERA_DEAD_AFTER_MS.
    const screenLive = ref(true)
    // Penonton: identity staf yang suaranya sedang didengarkan. Default
    // kosong -- puluhan mikrofon sekaligus hanya jadi keributan, dan tidak
    // ada audio yang diunduh sebelum penonton memilih mendengarkan.
    const listening = ref([])
    // Jalur video saya: 'udp' | 'tcp' | null (belum diketahui). 'tcp' = UDP
    // diblokir (biasanya VPN/firewall), jauh lebih berat untuk server LiveKit
    // & gambar mudah patah-patah. Dilaporkan ke gateway bersama live:state.
    const mediaTransport = ref(null)
    const mediaOverTcp = computed(() => mediaTransport.value === 'tcp')
    // Penonton: identity staf -> 'udp' | 'tcp' (dari gateway).
    const transportByIdentity = ref({})
    // Room siaran saya sedang menyambung ulang ke LiveKit. Selama itu status
    // kamera/layar TIDAK dilaporkan -- yang putus server, bukan staf yang
    // mematikan kamera (tanpa laporan, status jadi DISCONNECTED, bukan ALERT).
    const reconnecting = ref(false)

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
        clearTimeout(bumpTimer)
        bumpTimer = null
        revision.value++
    }

    // Siapa yang sedang bicara & kualitas koneksi berubah berkali-kali per
    // detik; tiap bump me-render ulang seluruh grid Live Kerja. Untuk event
    // seperti itu cukup satu render per BUMP_THROTTLE_MS.
    function bumpSoon() {
        bumpTimer ??= setTimeout(bump, BUMP_THROTTLE_MS)
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
                // 180p untuk kamera pojok di grid (lebarnya < 200 px) -- dulu
                // ubin itu menerima 360p, 3x lebih banyak paket yang harus
                // diteruskan server tanpa beda yang terlihat.
                videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
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
            .on(RoomEvent.ConnectionQualityChanged, bumpSoon)
            .on(RoomEvent.ActiveSpeakersChanged, bumpSoon)
            .on(RoomEvent.LocalTrackPublished, handleLocalTracksChanged)
            .on(RoomEvent.LocalTrackUnpublished, handleLocalTracksChanged)
            .on(RoomEvent.TrackMuted, handleLocalCameraStopped)
            .on(RoomEvent.TrackUnmuted, handleLocalTracksChanged)
            .on(RoomEvent.Reconnecting, () => handleReconnecting(room))
            .on(RoomEvent.SignalReconnecting, () => handleReconnecting(room))
            .on(RoomEvent.Reconnected, () => handleReconnected(room))
            .on(RoomEvent.Disconnected, () => handleRoomDisconnected(siteId, room))

        // autoSubscribe: false -- LiveView yang memilih peserta mana yang
        // di-subscribe (hanya yang tampil di halaman grid saat ini), bukan
        // langsung menerima video semua staf se-site sekaligus.
        await room.connect(livekitUrl, token, { autoSubscribe: false })
        rooms.set(siteId, room)
        startTransportCheck()
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
                setSubscribed(participant.getTrackPublication(CAMERA_SOURCE), visible)
                setSubscribed(participant.getTrackPublication(SCREEN_SOURCE), visible)
                setSubscribed(participant.getTrackPublication(MICROPHONE_SOURCE), listened.has(participant.identity))
            }
        }
    }

    // setSubscribed() di livekit-client SELALU mengirim pesan ke server walau
    // nilainya sama -- dan fungsi di atas dipanggil di tiap event peserta.
    // Tanpa cek ini, 50 staf live = ±150 pesan per event, berkali-kali per detik.
    function setSubscribed(publication, subscribed) {
        if (publication && publication.isDesired !== subscribed) publication.setSubscribed(subscribed)
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
        ownScreenTrack = null
        reconnecting.value = false
        cameraProblem.value = null
        broadcastStartedAt.value = null
        onBreak.value = false
        isIdle.value = false
        myStatus.value = null
        screenRequired.value = false
        micProblem.value = null
        cameraLive.value = true
        cameraDeadSince = null
        cameraMutedSince = null
        screenLive.value = true
        screenDeadSince = null
    }

    /** Satu RTCRtpSender/Receiver yang sedang aktif, untuk membaca jalur ICE. */
    function transportProbe() {
        const ownCamera = ownRoom?.localParticipant.getTrackPublication(CAMERA_SOURCE)?.track
        if (ownCamera?.sender) return ownCamera.sender
        for (const room of rooms.values()) {
            for (const participant of room.remoteParticipants.values()) {
                for (const publication of participant.trackPublications.values()) {
                    if (publication.track?.receiver) return publication.track.receiver
                }
            }
        }
        return null
    }

    function checkTransport() {
        // getSelectedCandidatePair: Chrome & Edge (browser yang dipakai siaran).
        const pair = transportProbe()?.transport?.iceTransport?.getSelectedCandidatePair?.()
        if (!pair) return
        const transport = pair.local.protocol === 'tcp' || pair.local.type === 'relay' ? 'tcp' : 'udp'
        if (transport === mediaTransport.value) return
        mediaTransport.value = transport
        // Penonton langsung melihat perubahannya, tidak menunggu laporan berkala.
        if (mode.value === 'broadcasting') scheduleReport()
    }

    function startTransportCheck() {
        if (transportTimer) return
        transportTimer = setInterval(checkTransport, TRANSPORT_CHECK_MS)
        setTimeout(checkTransport, 5_000)
    }

    function stopTransportCheck() {
        clearInterval(transportTimer)
        transportTimer = null
        mediaTransport.value = null
    }

    async function disconnect() {
        stopTransportCheck()
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
        releaseLiveSocketIfUnused()
        bump()
    }

    // Diputus dari sisi server (sesi ditutup timeout, staf dikeluarkan) atau
    // koneksi gagal total setelah LiveKit menyerah reconnect.
    function handleRoomDisconnected(siteId, room) {
        const wasBroadcasting = room === ownRoom && mode.value === 'broadcasting'
        if (rooms.get(siteId) === room) rooms.delete(siteId)
        watchedSiteIds.value = watchedSiteIds.value.filter((id) => rooms.has(id))
        if (rooms.size === 0) stopTransportCheck()
        if (room === ownRoom || rooms.size === 0) {
            ownRoom = null
            stopHeartbeat()
            stopIdleWatch()
            releaseWakeLock()
            resetBroadcastState()
        }
        bump()
        if (wasBroadcasting) scheduleRejoin()
    }

    const ownRoomReady = () => ownRoom?.state === CONNECTED

    function handleReconnecting(room) {
        if (room !== ownRoom) return
        reconnecting.value = true
        bump()
    }

    function handleReconnected(room) {
        applySubscriptions()
        if (room !== ownRoom) return bump()
        reconnecting.value = false
        // Hitung ulang dari nol: selama menyambung ulang track memang tidak terkirim.
        cameraDeadSince = null
        cameraMutedSince = null
        screenDeadSince = null
        setTimeout(republishMissingTracks, Math.random() * REPUBLISH_JITTER_MS)
        scheduleReport()
        bump()
    }

    /**
     * LiveKit menerbitkan ulang track sendiri setelah menyambung ulang, tapi
     * bisa gagal saat server kewalahan (negosiasi timeout) -- kamera & layar
     * lalu terlepas dan staf tampil CAMERA/SCREEN OFF padahal tidak mematikan
     * apa pun. Terbitkan lagi di sini: kamera dibuka ulang, layar memakai track
     * yang masih hidup (tanpa dialog pilih layar). Layar yang dihentikan staf
     * sendiri ("Stop sharing") sudah 'ended', jadi tidak ikut diterbitkan.
     */
    async function republishMissingTracks() {
        if (republishing || !ownRoomReady() || mode.value !== 'broadcasting') return
        if (Date.now() - lastRepublishAt < REPUBLISH_MIN_GAP_MS) return
        const participant = ownRoom.localParticipant
        const missingCamera = !participant.getTrackPublication(CAMERA_SOURCE) && !onBreak.value
        const missingScreen =
            !participant.getTrackPublication(SCREEN_SOURCE) && ownScreenTrack?.mediaStreamTrack?.readyState === 'live'
        if (!missingCamera && !missingScreen) return

        republishing = true
        lastRepublishAt = Date.now()
        try {
            if (missingCamera) await participant.setCameraEnabled(true)
            if (missingScreen) await participant.publishTrack(ownScreenTrack)
        } catch {
            // Dicoba lagi pada cek kamera/layar berikutnya (paling cepat REPUBLISH_MIN_GAP_MS).
        } finally {
            republishing = false
            handleLocalTracksChanged()
        }
    }

    /**
     * Room siaran putus total. Sesi kerja masih terbuka di server, jadi sambung
     * lagi otomatis (seperti setelah reload) dengan jeda acak & makin panjang --
     * staf tidak perlu menekan apa pun. Layar perlu dibagikan ulang lewat
     * ScreenShareLock (browser mewajibkan klik untuk dialog pilih layar).
     */
    function scheduleRejoin() {
        clearTimeout(rejoinTimer)
        if (rejoinAttempt >= REJOIN_DELAYS_MS.length) return
        const delay = REJOIN_DELAYS_MS[rejoinAttempt++] + Math.random() * REJOIN_JITTER_MS
        rejoinTimer = setTimeout(async () => {
            rejoinTimer = null
            if (mode.value !== 'idle') return
            resumeTask = null
            const { resumed, error } = await resumeIfBroadcasting()
            if (resumed) rejoinAttempt = 0
            // Tanpa error = tidak ada sesi kerja lagi (ditutup/logout) -> berhenti.
            else if (error) scheduleRejoin()
        }, delay)
    }

    function cancelRejoin() {
        clearTimeout(rejoinTimer)
        rejoinTimer = null
        rejoinAttempt = 0
    }

    const watchSite = (siteId) => watchSites([siteId])

    /**
     * Tonton satu atau beberapa site sekaligus. Site yang gagal tersambung
     * dilewati; error baru dilempar kalau SEMUA site gagal.
     */
    async function watchSites(siteIds) {
        connecting.value = true
        try {
            // Leader yang sedang siaran tetap di ruang leader-nya sendiri dan
            // ikut menonton site yang dipegangnya.
            const broadcasting = mode.value === 'broadcasting' && ownRoom
            if (broadcasting) await disconnectWatchRooms()
            else await disconnect()
            const results = await Promise.allSettled(
                siteIds
                    .filter((siteId) => !rooms.has(siteId))
                    .map(async (siteId) => {
                        const params = siteId === LEADERS_ROOM_KEY ? { room: LEADERS_ROOM_KEY } : { organization_id: siteId }
                        const response = await api.post('/live/watch-token', params)
                        const { livekit_url, token } = response.data.data
                        await connect(livekit_url, token, siteId)
                    }),
            )
            if (!rooms.size) throw results.find((result) => result.status === 'rejected')?.reason ?? new Error('Tidak ada site')
            watchedSiteIds.value = [...rooms.keys()]
            if (broadcasting) return
            organizationId.value = siteIds.length === 1 ? siteIds[0] : null
            mode.value = 'watching'
        } finally {
            connecting.value = false
        }
    }

    /** Putus semua room tonton, kecuali room siaran saya sendiri. */
    async function disconnectWatchRooms() {
        const watched = [...rooms].filter(([, room]) => room !== ownRoom)
        watched.forEach(([siteId]) => rooms.delete(siteId))
        await Promise.all(watched.map(([, room]) => room.removeAllListeners().disconnect()))
        bump()
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

    const cameraIsLive = () => trackIsLive(CAMERA_SOURCE)

    // Kamera bisa tetap 'live' tapi tidak mengirim gambar sama sekali --
    // browser hanya menandainya muted (mis. direbut aplikasi lain, driver
    // tersendat). LiveKit tidak menganggapnya mati, jadi checkCamera() cek
    // sendiri -- dengan tenggang lebih lama, karena muted juga sering
    // muncul sesaat (kamera baru menyala, CPU sibuk).
    const cameraMuted = () => !!ownRoom?.localParticipant.getTrackPublication(CAMERA_SOURCE)?.track?.mediaStreamTrack?.muted

    /**
     * Panggil langsung dari klik tombol: dialog pilih layar & izin deteksi
     * idle butuh user gesture. Di komputer, layar dibagikan SEBELUM kamera
     * menyala -- mulai kerja = layar + kamera langsung tersiar.
     */
    async function startWork({ resuming = false } = {}) {
        // Layar & kamera wajib -- browser HP tidak bisa membagikan layar.
        if (!canShareScreen) {
            const error = new Error('Live Kerja hanya bisa dari komputer (Chrome atau Edge): layar & kamera wajib dibagikan.')
            error.name = 'ComputerRequired'
            throw error
        }
        if (!resuming) cancelRejoin()
        connecting.value = true
        cameraProblem.value = null
        let screenTrack = null
        // Melanjutkan otomatis setelah reload tidak punya klik user, dan
        // browser menolak dialog pilih layar tanpa klik -- layar dibagikan
        // lewat kunci "Layar wajib dibagikan" (ScreenShareLock) sesudahnya.
        // Izin notifikasi desktop untuk peringatan "layar tidak dibagikan"
        // (ScreenShareLock) -- harus diminta dari klik, jadi di sini.
        if (!resuming && typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Notification.requestPermission().catch(() => {})
        }
        try {
            if (!resuming) screenTrack = await captureEntireScreen()
        } catch (err) {
            connecting.value = false
            throw err
        }
        const idlePermission = resuming ? idlePermissionAlreadyGranted() : requestIdlePermission()
        try {
            // device: backend menolak Mulai kerja dari selain komputer (APK
            // Live / klien lama tidak mengirimnya) -- layar wajib dibagikan.
            const response = await api.post('/live/sessions/start', { device: 'computer' })
            const { livekit_url, token, session } = response.data.data
            await disconnect()
            // Sesi leader tanpa site -> ruang leader.
            const roomKey = session.organization_id ?? LEADERS_ROOM_KEY
            ownRoom = await connect(livekit_url, token, roomKey)
            organizationId.value = session.organization_id
            watchedSiteIds.value = [roomKey]
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
            if (screenTrack) {
                await ownRoom.localParticipant.publishTrack(screenTrack)
                ownScreenTrack = screenTrack
            }
            // Siaran baru = mikrofon BISU (hemat server); melanjutkan setelah
            // reload = ikut pilihan bisu terakhir staf.
            if (!resuming) setMicMutedPref(true)
            await enableMicrophone()
            screenRequired.value = true
            mode.value = 'broadcasting'
            broadcastStartedAt.value = session.started_at ?? new Date().toISOString()
            onBreak.value = !!session.on_break
            startHeartbeat()
            // Heartbeat berikutnya lewat socket; yang pertama ini masih HTTP
            // kalau socket belum tersambung (lihat sendHeartbeat).
            ensureLiveSocket()
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
            // Leader menyiarkan ke ruang leader (tanpa site); staf ke site-nya.
            const isLeader = auth.user?.roles?.includes('leader') ?? false
            const isStaff = auth.hasPermission('live.broadcast') && !!auth.user?.organization_id
            if (mode.value !== 'idle' || (!isLeader && !isStaff)) {
                return { resumed: false }
            }
            try {
                const params = isLeader ? {} : { organization_id: auth.user.organization_id }
                const response = await api.get('/live/sessions', { params })
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

    /**
     * Buka ulang kamera tanpa memutus siaran. restartTrack() mengganti sumber
     * gambar di track yang sama -- tidak ada mute/unmute yang disiarkan ke
     * semua peserta room seperti setCameraEnabled(false/true). Unmute hanya
     * kalau LiveKit sendiri sudah membisukan track-nya (kamera sempat 'ended').
     * Perubahan status dilaporkan checkCamera(), bukan di sini.
     */
    async function restartCamera() {
        // Saat LiveKit menyambung ulang, membuka ulang kamera hanya menambah
        // negosiasi ke server yang sedang kewalahan -- tunggu sampai tersambung.
        if (!ownRoomReady() || mode.value !== 'broadcasting') return
        const track = ownRoom.localParticipant.getTrackPublication(CAMERA_SOURCE)?.track
        if (track) {
            await track.restartTrack()
            if (track.isMuted) await track.unmute()
        } else {
            await ownRoom.localParticipant.setCameraEnabled(true)
        }
        await new Promise((resolve) => setTimeout(resolve, 800))
        cameraProblem.value =
            cameraIsLive() && !cameraMuted()
                ? null
                : 'Kamera masih belum mengirim gambar. Periksa izin kamera di browser dan pastikan tidak dipakai aplikasi lain.'
        bump()
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
            ownScreenTrack = track
            // Layar baru langsung terkirim -- jangan tunggu checkScreen() membuka kunci.
            screenLive.value = true
            screenDeadSince = null
        } else {
            ownScreenTrack = null
            await ownRoom.localParticipant.setScreenShareEnabled(false)
        }
        handleLocalTracksChanged()
    }

    async function setBreak(enabled) {
        onBreak.value = enabled
        await sendHeartbeat()
    }

    async function endWork() {
        cancelRejoin()
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
        // Room siaran sedang menyambung ulang: kamera/layar memang tidak
        // terkirim, tapi bukan karena staf -- jangan laporkan "kamera mati".
        // Tanpa laporan, server menandai DISCONNECTED setelah 75 detik.
        if (!ownRoomReady()) return
        const state = {
            // cameraLive: kamera yang di-mute browser cukup lama juga mati.
            camera_active: cameraLive.value && cameraIsLive(),
            screen_active: trackIsLive(SCREEN_SOURCE),
            on_break: onBreak.value,
            idle: isIdle.value,
        }

        // Lewat socket gateway: tanpa request HTTP, tanpa PHP. HTTP hanya
        // cadangan kalau socket sedang tidak tersambung. Jalur video hanya
        // penanda tampilan di gateway, tidak dikirim ke heartbeat HTTP.
        const reply = await reportOverSocket({ ...state, transport: mediaTransport.value })
        if (reply?.closed) return disconnect()
        if (reply?.ok) {
            myStatus.value = reply.status ?? null
            return
        }

        try {
            const response = await api.post('/live/sessions/heartbeat', state)
            myStatus.value = response.data.data?.status ?? null
        } catch (err) {
            // 404 = server sudah menutup sesi (mis. jaringan sempat putus
            // lebih lama dari batas timeout) -- berhenti menyiarkan.
            if (err.response?.status === 404) await disconnect()
        }
    }

    // ---- Socket Live Kerja (realtime-gateway, namespace /ops)
    // Staf yang siaran mengirim status lewat `live:state`; penonton menerima
    // perubahan status staf lewat `live:status` -- pengganti heartbeat HTTP &
    // polling /live/overview (lihat realtime-gateway/app/services/live_hub.ts).

    function ensureLiveSocket() {
        if (liveSocket && liveSocketToken === auth.token) return liveSocket
        closeLiveSocket()
        if (!auth.token) return null

        liveSocketToken = auth.token
        liveSocket = io(`${import.meta.env.VITE_GATEWAY_WS_URL}/ops`, {
            transports: ['websocket'],
            auth: { token: auth.token },
        })
        liveSocket.on('connect', () => {
            if (liveWatchIds.length) emitWatch()
            if (mode.value === 'broadcasting') scheduleReport()
        })
        liveSocket.on('live:status', (event) => {
            if ('transport' in event) setTransportOf(event.participant_identity, event.transport)
            liveStatusListeners.forEach((listener) => listener(event))
        })
        liveSocket.on('session:expired', async () => {
            auth.clearSession()
            await disconnect()
            const { default: router } = await import('@/router')
            router.push({ name: 'login' })
        })
        return liveSocket
    }

    function closeLiveSocket() {
        liveSocket?.disconnect()
        liveSocket = null
        liveSocketToken = null
    }

    /** Tutup socket kalau tidak sedang siaran maupun menonton. */
    function releaseLiveSocketIfUnused() {
        if (mode.value !== 'broadcasting' && !liveWatchIds.length) closeLiveSocket()
    }

    function reportOverSocket(state) {
        const socket = ensureLiveSocket()
        if (!socket?.connected) return Promise.resolve(null)
        return new Promise((resolve) => {
            socket.timeout(SOCKET_REPORT_TIMEOUT_MS).emit('live:state', state, (err, reply) => resolve(err ? null : reply))
        })
    }

    function setTransportOf(identity, transport) {
        const next = { ...transportByIdentity.value }
        if (transport) next[identity] = transport
        else delete next[identity]
        transportByIdentity.value = next
    }

    /** Gabung room status site & ambil jalur video staf yang sudah siaran. */
    function emitWatch() {
        const organizationIds = liveWatchIds.filter((id) => typeof id === 'number')
        const leaders = liveWatchIds.includes(LEADERS_ROOM_KEY)
        ensureLiveSocket()?.emit('live:watch', { organizationIds, leaders }, (reply) => {
            if (reply?.transports) transportByIdentity.value = { ...reply.transports }
        })
    }

    /** Terima perubahan status staf di site-site ini (kosong = berhenti menonton). */
    function watchLiveStatus(organizationIds) {
        liveWatchIds = [...organizationIds]
        if (liveWatchIds.length) {
            emitWatch()
        } else {
            transportByIdentity.value = {}
            liveSocket?.emit('live:watch', { organizationIds: [] })
            releaseLiveSocketIfUnused()
        }
    }

    /** @returns {() => void} berhenti mendengarkan */
    function onLiveStatus(listener) {
        liveStatusListeners.add(listener)
        return () => liveStatusListeners.delete(listener)
    }

    // Beberapa event bisa datang beruntun (unpublish + mute) -- satu laporan saja.
    function scheduleReport() {
        clearTimeout(reportTimer)
        reportTimer = setTimeout(sendHeartbeat, 400)
    }

    function startHeartbeat() {
        stopHeartbeat()
        heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
        cameraCheckTimer = setInterval(() => {
            checkCamera()
            checkScreen()
        }, CAMERA_CHECK_MS)
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
        if (!ownRoomReady()) {
            cameraDeadSince = null
            cameraMutedSince = null
            return
        }
        if (!ownRoom.localParticipant.getTrackPublication(CAMERA_SOURCE)) republishMissingTracks()
        const now = Date.now()
        const alive = cameraIsLive()
        const muted = alive && cameraMuted()
        cameraDeadSince = alive ? null : (cameraDeadSince ?? now)
        cameraMutedSince = muted ? (cameraMutedSince ?? now) : null

        const dead =
            (cameraDeadSince !== null && now - cameraDeadSince >= CAMERA_DEAD_AFTER_MS) ||
            (cameraMutedSince !== null && now - cameraMutedSince >= CAMERA_MUTED_AFTER_MS)

        if (!alive || muted) {
            if (dead && cameraLive.value) {
                cameraLive.value = false
                scheduleReport()
            }
            return
        }
        if (!cameraLive.value) {
            cameraLive.value = true
            cameraProblem.value = null
            scheduleReport()
        }
    }

    // Layar: track bisa masih ada tapi sudah tidak mengirim (berakhir /
    // dibisukan) -- status SCREEN OFF, jadi kunci layar juga harus tampil.
    function checkScreen() {
        if (mode.value !== 'broadcasting') return
        if (!ownRoomReady()) {
            screenDeadSince = null
            return
        }
        if (!ownRoom.localParticipant.getTrackPublication(SCREEN_SOURCE)) republishMissingTracks()
        if (trackIsLive(SCREEN_SOURCE)) {
            screenDeadSince = null
            if (!screenLive.value) {
                screenLive.value = true
                scheduleReport()
            }
            return
        }
        screenDeadSince ??= Date.now()
        if (screenLive.value && Date.now() - screenDeadSince >= CAMERA_DEAD_AFTER_MS) {
            screenLive.value = false
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
        screenLive,
        localMicState,
        listening,
        mediaTransport,
        mediaOverTcp,
        transportByIdentity,
        reconnecting,
        connecting,
        isBroadcasting,
        remoteParticipants,
        participantSites,
        watchedSiteIds,
        localCameraTrack,
        localScreenTrack,
        watchLiveStatus,
        onLiveStatus,
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
