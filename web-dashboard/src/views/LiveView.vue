<script setup>
import {
    ArrowLeftRight,
    ChevronLeft,
    ChevronRight,
    Coffee,
    LayoutGrid,
    Maximize,
    Mic,
    MicOff,
    Minimize,
    MonitorUp,
    MonitorX,
    Network,
    Play,
    RefreshCw,
    Search,
    Smartphone,
    Square,
    Video,
    VolumeX,
    X,
} from '@lucide/vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import LiveAudioButton from '@/components/live/LiveAudioButton.vue'
import LiveMiniTile from '@/components/live/LiveMiniTile.vue'
import LiveStatusBar from '@/components/live/LiveStatusBar.vue'
import LivePairTile from '@/components/live/LivePairTile.vue'
import LoginDeviceIcon from '@/components/live/LoginDeviceIcon.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { formatElapsed, useNow } from '@/composables/useNow'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { ATTENTION_STATUSES, WORK_STATUS, workStatus } from '@/lib/workStatus'
import { useAuthStore } from '@/stores/auth'
import { CAMERA_SOURCE, LEADERS_ROOM_KEY, SCREEN_SOURCE, canShareScreen, micStateOf, useLiveStore } from '@/stores/live'

const ALL_SITES = 'all'

const auth = useAuthStore()
const live = useLiveStore()
const toast = useToast()
const now = useNow()

const sites = ref([])
// ALL_SITES = semua site yang boleh ditonton sekaligus, atau id satu site.
const selectedSiteId = ref(null)
const mySession = ref(null)
const page = ref(0)
// Disimpan identity-nya, bukan objek peserta: kalau staf itu reconnect
// (sinyal putus-sambung), LiveKit membuat objek peserta baru dan objek lama
// tidak punya track lagi -- tampilan besar harus ikut objek yang baru.
const focusedIdentity = ref(null)
const focused = computed(() => live.remoteParticipants.find((p) => p.identity === focusedIdentity.value) ?? null)
const confirmStartOpen = ref(false)
const confirmEndOpen = ref(false)

// Leader juga Live Kerja, tapi di ruang leader (terpisah dari staf) yang hanya
// ditonton peran di atasnya (admin & root).
const isLeader = computed(() => auth.user?.roles?.includes('leader') ?? false)
// Siaran leader hanya ditonton peran di atasnya (admin & root).
const canWatchLeaders = computed(() => ['super_admin', 'admin'].some((role) => auth.user?.roles?.includes(role)))
const canBroadcast = computed(() => isLeader.value || (auth.hasPermission('live.broadcast') && !!auth.user?.organization_id))
const isAllSites = computed(() => selectedSiteId.value === ALL_SITES)
const siteNames = computed(() => Object.fromEntries(sites.value.map((site) => [site.id, site.name])))
const totalLive = computed(() => sites.value.reduce((total, site) => total + (site.live_count ?? 0), 0))

// ---- Preferensi tampilan, diingat per browser (kebiasaan tiap penonton beda).
function readPref(key, fallback) {
    try {
        return JSON.parse(localStorage.getItem(key)) ?? fallback
    } catch {
        return fallback
    }
}

function writePref(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value))
    } catch {
        // mode privat / penyimpanan diblokir -- cukup tidak diingat
    }
}

const LAYOUTS = [1, 2, 4]
const savedLayout = readPref('lacak_live_layout', 4)
const layout = ref(LAYOUTS.includes(savedLayout) ? savedLayout : 4)
// false = layar di kiri, kamera di kanan (bawaan).
const swapped = ref(readPref('lacak_live_swapped', false) === true)
watch(layout, (value) => {
    writePref('lacak_live_layout', value)
    page.value = 0
})
watch(swapped, (value) => writePref('lacak_live_swapped', value))

// Porsi kamera (wajah) terhadap layar kerja. Bawaan "kecil": yang dipantau
// terutama layar kerjanya, wajah cukup sebagai bukti kehadiran.
const CAMERA_SIZES = [
    { value: 'equal', label: 'Sama besar' },
    { value: 'small', label: 'Kecil' },
    { value: 'corner', label: 'Pojok' },
]
const savedCameraSize = readPref('lacak_live_camera_size', 'small')
const cameraSize = ref(CAMERA_SIZES.some((option) => option.value === savedCameraSize) ? savedCameraSize : 'small')
watch(cameraSize, (value) => writePref('lacak_live_camera_size', value))

// ---- Status semua staf: dimuat sekali dari /live/overview, lalu perubahan
// per staf didorong gateway lewat socket (live:status). Muat ulang penuh
// hanya sesekali sebagai pengaman (staf baru di roster, socket sempat putus).
const STATUS_RESYNC_MS = 2 * 60_000
const roster = ref([])
const leadersRoster = ref([])
const sessionByIdentity = ref({})
let statusTimer = null
let stopLiveStatus = null

function applyLiveStatus(event) {
    const sessions = { ...sessionByIdentity.value }
    if (event.session) sessions[event.participant_identity] = event.session
    else delete sessions[event.participant_identity]
    sessionByIdentity.value = sessions

    const update = (member) =>
        member.user_id === event.user_id ? { ...member, status: event.status, started_at: event.started_at } : member
    roster.value = roster.value.map(update)
    leadersRoster.value = leadersRoster.value.map(update)
}

watch(
    () => live.watchedSiteIds,
    (siteIds) => live.watchLiveStatus(siteIds),
    { immediate: true },
)

async function loadStatus() {
    try {
        const response = await api.get('/live/overview')
        const data = response.data.data
        sites.value = data.sites
        roster.value = data.roster
        leadersRoster.value = data.leaders?.roster ?? []
        sessionByIdentity.value = Object.fromEntries(
            [...data.items, ...(data.leaders?.items ?? [])].map((session) => [session.participant_identity, session]),
        )
    } catch {
        // Status & durasi tidak wajib -- tapi daftar site wajib ada supaya
        // video tetap bisa ditonton (mis. server belum punya /live/overview).
        if (!sites.value.length) {
            const response = await api.get('/live/sites').catch(() => null)
            sites.value = response?.data.data ?? []
        }
    }
}

// Staf baru masuk room sebelum status berkalanya termuat -> muat ulang lebih
// awal. Watcher ini terpicu di SETIAP event LiveKit (indikator bicara dst),
// dan /live/overview berat -- jadi hanya untuk identity yang belum pernah
// dicari, dan paling sering sekali per OVERVIEW_MIN_GAP_MS. Peserta tanpa
// sesi kerja (mis. sesinya baru ditutup) tidak memicu muat ulang lagi;
// statusnya ikut diperbarui lewat socket (live:status) & resync berkala.
const OVERVIEW_MIN_GAP_MS = 5_000
const requestedIdentities = new Set()
let lastEarlyLoadAt = 0
let earlyLoadTimer = null

function loadStatusSoon() {
    if (earlyLoadTimer) return
    const wait = Math.max(0, lastEarlyLoadAt + OVERVIEW_MIN_GAP_MS - Date.now())
    earlyLoadTimer = setTimeout(() => {
        earlyLoadTimer = null
        lastEarlyLoadAt = Date.now()
        loadStatus()
    }, wait)
}

watch(
    () => live.remoteParticipants.map((p) => p.identity),
    (identities) => {
        const unknown = identities.filter((id) => !(id in sessionByIdentity.value) && !requestedIdentities.has(id))
        if (!unknown.length) return
        unknown.forEach((id) => requestedIdentities.add(id))
        loadStatusSoon()
    },
)

function statusOf(participant) {
    return sessionByIdentity.value[participant.identity]?.status ?? null
}

// Kapan tiap staf mulai kerja. Kalau belum termuat, pakai waktu bergabung
// ke room LiveKit sebagai perkiraan.
function liveSince(participant) {
    return sessionByIdentity.value[participant.identity]?.started_at ?? participant.joinedAt ?? null
}

function siteNameOf(participant) {
    return isAllSites.value ? (siteNames.value[live.participantSites[participant.identity]] ?? null) : null
}

// ---- Cari & saring: berlaku untuk dinding video DAN daftar status.
const search = ref('')
const statusFilter = ref(null)

function matchesSearch(name) {
    const query = search.value.trim().toLowerCase()
    return !query || name.toLowerCase().includes(query)
}

const siteRoster = computed(() =>
    isAllSites.value ? roster.value : roster.value.filter((staff) => staff.organization_id === selectedSiteId.value),
)

const statusCounts = computed(() =>
    Object.keys(WORK_STATUS)
        .map((key) => ({ key, ...WORK_STATUS[key], count: siteRoster.value.filter((staff) => staff.status === key).length }))
        .filter((entry) => entry.count),
)

const countOf = (keys) => siteRoster.value.filter((staff) => keys.includes(staff.status)).length
const liveNow = computed(() => siteRoster.value.filter((staff) => staff.started_at).length)

// Cincin warna di ubin staf yang butuh perhatian -- terlihat dari jauh di dinding pantau.
const ATTENTION_RING = {
    alert: 'ring-2 ring-danger-500 ring-offset-2 ring-offset-base-950',
    disconnected: 'ring-2 ring-st-disconnected/70',
    screen_off: 'ring-2 ring-st-screen/70',
    camera_off: 'ring-2 ring-st-camera/70',
}
const attentionRing = (participant) => ATTENTION_RING[statusOf(participant)] ?? ''

const filteredRoster = computed(() =>
    siteRoster.value
        .filter((staff) => (!statusFilter.value || staff.status === statusFilter.value) && matchesSearch(staff.name))
        // Yang perlu perhatian di atas, lalu yang sedang live, offline paling bawah.
        .sort((a, b) => rosterRank(a.status) - rosterRank(b.status) || a.name.localeCompare(b.name)),
)

function rosterRank(status) {
    if (ATTENTION_STATUSES.includes(status)) return 0
    return status === 'offline' ? 2 : 1
}

// ---- Jalur video staf (UDP normal / TCP lewat VPN yang memblokir UDP).
const transportFilter = ref(null)

function transportOf(participant) {
    return live.transportByIdentity[participant.identity] ?? null
}

const transportCounts = computed(() => {
    const counts = { udp: 0, tcp: 0 }
    for (const participant of live.remoteParticipants) {
        const transport = transportOf(participant)
        if (transport) counts[transport]++
    }
    return counts
})

// Leader yang siaran tampil di bagian Leader sendiri, bukan di dinding staf.
const isLeaderParticipant = (participant) => live.participantSites[participant.identity] === LEADERS_ROOM_KEY
const leaderParticipants = computed(() => live.remoteParticipants.filter(isLeaderParticipant))
const leadersLive = computed(() => leadersRoster.value.filter((leader) => leader.started_at).length)

const wallParticipants = computed(() =>
    live.remoteParticipants.filter(
        (participant) =>
            !isLeaderParticipant(participant) &&
            (!statusFilter.value || statusOf(participant) === statusFilter.value) &&
            (!transportFilter.value || transportOf(participant) === transportFilter.value) &&
            matchesSearch(participant.name || participant.identity),
    ),
)

// Urutan pindah staf di tampilan besar: leader dulu, lalu dinding staf (ikut saringan).
const focusList = computed(() => [...leaderParticipants.value, ...wallParticipants.value])
const focusIndex = computed(() => focusList.value.findIndex((p) => p.identity === focusedIdentity.value))
const focusPosition = computed(() => (focusIndex.value >= 0 ? `${focusIndex.value + 1} dari ${focusList.value.length}` : ''))

function focusStep(direction) {
    const list = focusList.value
    if (list.length < 2) return
    const index = focusIndex.value < 0 ? 0 : (focusIndex.value + direction + list.length) % list.length
    focusedIdentity.value = list[index].identity
}

// Hanya peserta di halaman yang tampil yang di-subscribe (lihat
// live.setVisibleParticipants), jadi menonton 100+ staf tidak berarti
// mengunduh 100+ video sekaligus.
// Lebih dari 4 staf live -> semua tampil sebagai ubin kecil (klik = popup
// besar). Pilihan 1/2/4 layar hanya berlaku saat yang live 4 orang atau kurang.
const COMPACT_THRESHOLD = 4
const COMPACT_PAGE_SIZE = 24
const compact = computed(() => wallParticipants.value.length > COMPACT_THRESHOLD)
const pageSize = computed(() => (compact.value ? COMPACT_PAGE_SIZE : layout.value))
const pageCount = computed(() => Math.max(1, Math.ceil(wallParticipants.value.length / pageSize.value)))
const visibleParticipants = computed(() => wallParticipants.value.slice(page.value * pageSize.value, (page.value + 1) * pageSize.value))
const wallGridClass = computed(() => {
    if (compact.value) return 'grid-cols-2 sm:grid-cols-3 2xl:grid-cols-4'
    return layout.value === 4 ? '2xl:grid-cols-2' : 'grid-cols-1'
})
watch(compact, () => (page.value = 0))

// Video yang diunduh: halaman dinding staf yang tampil + semua leader.
watch(
    [visibleParticipants, leaderParticipants],
    ([participants, leaders]) => live.setVisibleParticipants([...participants, ...leaders].map((p) => p.identity)),
    { immediate: true },
)
watch(pageCount, (count) => {
    if (page.value >= count) page.value = count - 1
})
watch([search, statusFilter, transportFilter], () => (page.value = 0))

function trackOf(participant, source) {
    return participant.getTrackPublication(source)?.track ?? null
}

const isListening = (participant) => live.listening.includes(participant.identity)
// Yang didengarkan tapi sudah tidak live lagi tidak dihitung.
const listeningCount = computed(() => live.remoteParticipants.filter(isListening).length)

// ---- Cari staf yang sedang siaran: hasil muncul saat mengetik, pilih satu
// nama = siarannya dibuka di tampilan besar. Tekan "/" untuk langsung mengetik.
const SEARCH_RESULT_LIMIT = 8
const searchInput = ref(null)
const searchOpen = ref(false)
const searchActive = ref(0)

const searchResults = computed(() =>
    search.value.trim() ? live.remoteParticipants.filter((p) => matchesSearch(p.name || p.identity)) : [],
)
const searchShown = computed(() => searchResults.value.slice(0, SEARCH_RESULT_LIMIT))
const searchSiteName = (participant) => {
    const siteId = live.participantSites[participant.identity]
    return siteId === LEADERS_ROOM_KEY ? 'Leader' : (siteNames.value[siteId] ?? null)
}

watch(search, () => {
    searchActive.value = 0
    searchOpen.value = !!search.value.trim()
})

function openSearchResult(participant) {
    focusedIdentity.value = participant.identity
    searchOpen.value = false
}

function onSearchKeydown(event) {
    const count = searchShown.value.length
    if (event.key === 'Escape') {
        if (searchOpen.value) searchOpen.value = false
        else search.value = ''
        return
    }
    if (!count) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        searchOpen.value = true
        searchActive.value = (searchActive.value + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
    } else if (event.key === 'Enter' && searchOpen.value) {
        event.preventDefault()
        openSearchResult(searchShown.value[searchActive.value])
    }
}

function focusSearchShortcut(event) {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target
    if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
    if (!searchInput.value) return
    event.preventDefault()
    searchInput.value.focus()
}

function focusStaff(staff) {
    if (live.remoteParticipants.some((p) => p.identity === staff.participant_identity)) {
        focusedIdentity.value = staff.participant_identity
    }
}

// ---- Layar penuh untuk dinding pantau (mis. ditayangkan di monitor ruang kontrol).
const wallEl = ref(null)
const isFullscreen = ref(false)

function syncFullscreen() {
    isFullscreen.value = !!wallEl.value && document.fullscreenElement === wallEl.value
}

async function toggleFullscreen() {
    try {
        if (document.fullscreenElement) await document.exitFullscreen()
        else await wallEl.value?.requestFullscreen()
    } catch {
        toast.error('Layar penuh tidak tersedia', 'Browser ini tidak mengizinkan mode layar penuh.')
    }
}

const focusedSince = computed(() => (focused.value ? liveSince(focused.value) : null))
const ownSiteName = computed(() =>
    live.isBroadcasting && live.organizationId === null ? 'Ruang leader' : (siteNames.value[live.organizationId] ?? null),
)
const broadcastElapsed = computed(() => formatElapsed(live.broadcastStartedAt, now.value))
const myStatusMeta = computed(() => (live.myStatus ? workStatus(live.myStatus) : null))
// Dibaca ulang tiap detik (ikut `now`) -- kamera HP bisa menurunkan resolusi
// sendiri saat panas atau cahaya kurang.
const cameraSettings = computed(() => {
    now.value
    live.localCameraTrack
    return live.isBroadcasting ? live.localCameraSettings() : null
})

async function loadMySession() {
    const params = isLeader.value ? {} : { organization_id: auth.user?.organization_id ?? undefined }
    const response = await api.get('/live/sessions', { params })
    mySession.value = response.data.data.my_session
}

/** Tonton satu site, atau ALL_SITES = semua site sekaligus (satu koneksi per site). */
async function selectSite(siteId) {
    // Staf yang siaran terkunci ke site sendiri; leader yang siaran tetap bisa
    // memantau site-site yang dipegangnya. Staf biasa tidak menonton siapa pun.
    if (auth.seesOnlySelf || (live.isBroadcasting && !isLeader.value)) return
    selectedSiteId.value = siteId
    page.value = 0
    try {
        const siteIds = siteId === ALL_SITES ? sites.value.map((site) => site.id) : [siteId]
        await live.watchSites(canWatchLeaders.value ? [...siteIds, LEADERS_ROOM_KEY] : siteIds)
    } catch (err) {
        toast.error('Gagal membuka siaran', err.response?.data?.message ?? err.message)
    }
}

const restartingCamera = ref(false)

async function restartCamera() {
    restartingCamera.value = true
    try {
        await live.restartCamera()
    } catch (err) {
        toast.error('Kamera gagal dinyalakan ulang', err.message)
    } finally {
        restartingCamera.value = false
    }
}

const togglingScreen = ref(false)

async function toggleScreenShare() {
    togglingScreen.value = true
    try {
        await live.setScreenShare(!live.localScreenTrack)
    } catch (err) {
        toast.error('Layar belum dibagikan', err.message)
    } finally {
        togglingScreen.value = false
        // Laporan status dikirim ~0,4 detik setelah track berubah.
        setTimeout(loadStatus, 1000)
    }
}

const togglingMic = ref(false)

async function toggleMicrophone() {
    togglingMic.value = true
    try {
        await live.setMicrophone(live.localMicState !== 'on')
    } catch (err) {
        toast.error('Mikrofon belum menyala', err.message)
    } finally {
        togglingMic.value = false
    }
}

const togglingBreak = ref(false)

async function toggleBreak() {
    togglingBreak.value = true
    try {
        await live.setBreak(!live.onBreak)
        toast.success(
            live.onBreak ? 'Istirahat dimulai' : 'Kembali bekerja',
            live.onBreak ? 'Jam istirahat tidak dihitung sebagai jam kerja.' : null,
        )
    } finally {
        togglingBreak.value = false
        loadStatus()
    }
}

async function startWork() {
    try {
        await live.startWork()
        mySession.value = null
        loadStatus()
        if (isLeader.value) {
            // Ruang leader sudah tersambung; site yang dipegang ditonton lagi.
            await selectSite(selectedSiteId.value ?? ALL_SITES)
        } else {
            selectedSiteId.value = live.organizationId
        }
        toast.success(
            'Mulai kerja',
            canShareScreen ? 'Layar & kamera Anda sedang disiarkan.' : 'Kamera Anda sedang disiarkan ke atasan Anda',
        )
    } catch (err) {
        const cameraMessages = {
            NotAllowedError: 'Izin kamera ditolak. Izinkan kamera untuk situs ini di pengaturan browser, lalu coba lagi.',
            NotFoundError: 'Kamera tidak ditemukan di perangkat ini.',
            NotReadableError: 'Kamera sedang dipakai aplikasi lain (Zoom, Teams, tab lain). Tutup dulu, lalu coba lagi.',
        }
        toast.error('Gagal memulai siaran', cameraMessages[err.name] ?? err.response?.data?.message ?? err.message)
        // startWork() memutus koneksi tonton yang lama -- sambung lagi supaya
        // penonton tetap melihat siaran site walau siarannya sendiri gagal.
        // (Batal/salah pilih layar terjadi sebelum koneksi tonton diputus.)
        if (err.name !== 'ScreenShareFailed' && selectedSiteId.value) await selectSite(selectedSiteId.value)
    } finally {
        confirmStartOpen.value = false
    }
}

async function endWork() {
    try {
        await live.endWork()
        toast.success('Selesai kerja', 'Siaran kamera & layar dihentikan')
        if (selectedSiteId.value) await selectSite(selectedSiteId.value)
    } catch (err) {
        toast.error('Gagal menghentikan siaran', err.response?.data?.message)
    } finally {
        confirmEndOpen.value = false
    }
}

onMounted(async () => {
    document.addEventListener('fullscreenchange', syncFullscreen)
    document.addEventListener('keydown', focusSearchShortcut)
    stopLiveStatus = live.onLiveStatus(applyLiveStatus)
    statusTimer = setInterval(loadStatus, STATUS_RESYNC_MS)

    try {
        await loadStatus()
        if (canBroadcast.value) await loadMySession()
    } catch (err) {
        toast.error('Gagal memuat data Live Kerja', err.response?.data?.message)
        return
    }

    // Setelah refresh, siaran yang sesinya masih terbuka disambung lagi
    // otomatis (lihat live.resumeIfBroadcasting, dipicu juga oleh AppShell).
    const resume = await live.resumeIfBroadcasting()
    if (resume.resumed) mySession.value = null

    // Koneksi tetap hidup saat pindah halaman (disimpan di store) -- jangan
    // sambung ulang kalau memang sudah terhubung.
    if (live.mode !== 'idle') {
        selectedSiteId.value = live.watchedSiteIds.length > 1 ? ALL_SITES : live.organizationId
        // Leader yang siarannya baru dilanjutkan: hanya ruang leader yang
        // tersambung -- tonton lagi site-site yang dipegangnya.
        if (isLeader.value && live.isBroadcasting && live.watchedSiteIds.length === 1) await selectSite(ALL_SITES)
        return
    }

    // Penonton multi-site langsung melihat semua staf yang live.
    if (sites.value.length > 1) {
        await selectSite(ALL_SITES)
        return
    }
    const defaultSite = sites.value.find((s) => s.id === auth.user?.organization_id) ?? sites.value[0]
    if (defaultSite) await selectSite(defaultSite.id)
})

onBeforeUnmount(() => {
    document.removeEventListener('fullscreenchange', syncFullscreen)
    document.removeEventListener('keydown', focusSearchShortcut)
    clearInterval(statusTimer)
    clearTimeout(earlyLoadTimer)
    stopLiveStatus?.()
    live.watchLiveStatus([])
})
</script>

<template>
    <div>
        <!-- Tanpa judul besar: layar ini untuk memantau, ruang vertikal dipakai video.
             Judul tetap ada untuk pembaca layar. -->
        <h1 class="sr-only">Live Kerja</h1>
        <div class="px-4 pt-5 sm:px-8 sm:pt-7">
            <LiveStatusBar
                :segments="statusCounts"
                :live="liveNow"
                :total="siteRoster.length"
                :active="statusFilter"
                @select="statusFilter = $event"
            >
                <template #actions>
                    <span
                        v-if="live.isBroadcasting"
                        class="inline-flex items-center gap-2 rounded-full bg-accent-500/12 px-3 py-1.5 text-xs font-bold text-accent-400"
                    >
                        <span class="beacon" />
                        Siaran Anda · {{ myStatusMeta?.label ?? 'Aktif' }}
                    </span>
                    <BaseButton
                        v-if="canBroadcast && canShareScreen && !live.isBroadcasting"
                        :loading="live.connecting"
                        @click="confirmStartOpen = true"
                    >
                        <Play class="size-4" />
                        {{ mySession ? 'Lanjutkan siaran' : 'Mulai kerja' }}
                    </BaseButton>
                </template>
            </LiveStatusBar>
        </div>

        <div class="space-y-5 p-4 sm:p-8">
            <div
                v-if="live.isBroadcasting && live.cameraProblem"
                class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger-500/30 bg-danger-500/10 px-4 py-3 text-sm text-danger-400"
                role="alert"
            >
                <span class="text-pretty">{{ live.cameraProblem }}</span>
                <BaseButton size="sm" variant="outline" :loading="restartingCamera" @click="restartCamera"
                    >Nyalakan ulang kamera</BaseButton
                >
            </div>

            <div
                v-if="live.isBroadcasting && live.reconnecting"
                class="flex items-start gap-3 rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-pretty text-warning-400"
                role="status"
            >
                <RefreshCw class="mt-0.5 size-4 shrink-0 motion-safe:animate-spin" />
                <span>
                    Koneksi ke server siaran terputus, sedang menyambung ulang otomatis. Kamera dan layar tersiar lagi tanpa perlu menekan
                    apa pun.
                </span>
            </div>

            <!-- Video lewat TCP (biasanya VPN/firewall memblokir UDP): berat untuk
                 server & gambar patah-patah. Yang memperbaiki tim IT, bukan staf. -->
            <div
                v-if="live.mediaOverTcp"
                class="flex items-start gap-3 rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-pretty text-warning-400"
                role="note"
            >
                <Network class="mt-0.5 size-4 shrink-0" />
                <span>
                    Video Live Kerja di perangkat ini lewat <strong>TCP</strong>, bukan UDP, biasanya karena VPN atau firewall memblokir
                    UDP. Gambar bisa patah-patah dan server jauh lebih berat. Minta tim IT mengizinkan
                    <strong>UDP port 7882-7889</strong> ke server Live.
                </span>
            </div>

            <!-- Layar & kamera wajib: browser HP tidak bisa membagikan layar,
                 jadi kerja (siaran) hanya bisa dimulai dari komputer. -->
            <div
                v-if="canBroadcast && !canShareScreen"
                class="flex items-start gap-3 rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-pretty text-warning-400"
                role="note"
            >
                <Smartphone class="mt-0.5 size-4 shrink-0" />
                <span>
                    Live Kerja wajib membagikan <strong>seluruh layar dan kamera</strong>, dan itu hanya bisa dari
                    <strong>komputer</strong> (Chrome atau Edge). Buka dashboard ini di komputer untuk Mulai kerja.
                </span>
            </div>

            <div
                v-if="mySession && !live.isBroadcasting"
                class="rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-pretty text-warning-400"
            >
                Sesi kerja Anda masih tercatat aktif sejak {{ new Date(mySession.started_at).toLocaleTimeString('id-ID') }}, tapi kamera
                tidak sedang menyiarkan. Tekan <strong>Lanjutkan siaran</strong>, atau sesi ditutup otomatis dalam beberapa menit.
            </div>

            <!-- Monitor siaran sendiri: layar + kamera saya, dan kendali kerja -->
            <section
                v-if="live.isBroadcasting"
                aria-label="Siaran Anda"
                class="grid gap-4 rounded-2xl border border-base-800 bg-base-900 p-3 shadow-(--shadow-card) sm:p-4 xl:grid-cols-[minmax(0,1fr)_18rem]"
            >
                <LivePairTile
                    class="self-start"
                    :name="auth.user?.name ?? 'Saya'"
                    :screen-track="live.localScreenTrack"
                    :camera-track="live.localCameraTrack"
                    :status="live.myStatus"
                    :transport="live.mediaTransport"
                    :swapped="swapped"
                    :camera-size="cameraSize"
                    mirror-camera
                />

                <aside class="flex flex-col gap-5 px-1 pb-1 xl:py-2 xl:pr-2">
                    <div>
                        <p class="eyebrow flex items-center gap-2">
                            <span class="beacon" />
                            Sedang disiarkan<template v-if="ownSiteName"> · {{ ownSiteName }}</template>
                        </p>
                        <p class="mt-2 font-display text-5xl leading-none font-extrabold tracking-[-0.045em] text-base-50 tabular-nums">
                            {{ broadcastElapsed }}
                        </p>
                        <p class="mt-1 text-xs text-base-500">lama sesi kerja</p>
                    </div>

                    <dl class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-base-800 bg-base-800 text-sm">
                        <div class="bg-base-900 px-3 py-2.5">
                            <dt class="eyebrow">Kamera</dt>
                            <dd class="mt-1 font-mono text-base-50 tabular-nums">
                                {{ cameraSettings ? `${cameraSettings.height}p · ${cameraSettings.frameRate}fps` : '—' }}
                            </dd>
                        </div>
                        <div class="bg-base-900 px-3 py-2.5">
                            <dt class="eyebrow">Layar</dt>
                            <dd class="mt-1 font-mono tabular-nums" :class="live.localScreenTrack ? 'text-base-50' : 'text-st-screen'">
                                {{ live.localScreenTrack ? 'Dibagikan' : 'Tidak' }}
                            </dd>
                        </div>
                        <div class="col-span-2 flex items-center gap-3 bg-base-900 px-3 py-2.5">
                            <div class="min-w-0 flex-1">
                                <dt class="eyebrow">Mikrofon</dt>
                                <dd
                                    class="mt-1 font-mono tabular-nums"
                                    :class="live.localMicState === 'on' ? 'text-base-50' : 'text-base-400'"
                                >
                                    {{ { on: 'Menyala', muted: 'Dibisukan', none: 'Tidak ada' }[live.localMicState] }}
                                </dd>
                            </div>
                            <BaseButton
                                :variant="live.localMicState === 'on' ? 'outline' : 'primary'"
                                size="sm"
                                :loading="togglingMic"
                                :aria-pressed="live.localMicState !== 'on'"
                                @click="toggleMicrophone"
                            >
                                <component :is="live.localMicState === 'on' ? MicOff : Mic" class="size-4" />
                                {{ live.localMicState === 'on' ? 'Bisukan' : 'Nyalakan mikrofon' }}
                            </BaseButton>
                        </div>
                    </dl>
                    <p v-if="live.micProblem" class="-mt-3 text-xs text-pretty text-warning-400">{{ live.micProblem }}</p>

                    <div class="grid gap-2">
                        <BaseButton
                            v-if="canShareScreen"
                            :variant="live.localScreenTrack ? 'outline' : 'primary'"
                            size="sm"
                            :loading="togglingScreen"
                            @click="toggleScreenShare"
                        >
                            <component :is="live.localScreenTrack ? MonitorX : MonitorUp" class="size-4" />
                            {{ live.localScreenTrack ? 'Hentikan berbagi layar' : 'Bagikan layar' }}
                        </BaseButton>
                        <p v-else class="text-xs text-pretty text-base-500">
                            Berbagi layar hanya bisa dari browser komputer (Chrome/Edge/Firefox). Dari HP, yang tersiar hanya kamera.
                        </p>
                        <BaseButton :variant="live.onBreak ? 'primary' : 'outline'" size="sm" :loading="togglingBreak" @click="toggleBreak">
                            <component :is="live.onBreak ? Play : Coffee" class="size-4" />
                            {{ live.onBreak ? 'Lanjut kerja' : 'Istirahat' }}
                        </BaseButton>
                    </div>

                    <div class="mt-auto flex flex-wrap gap-2">
                        <BaseButton variant="ghost" size="sm" :loading="restartingCamera" @click="restartCamera">
                            <RefreshCw class="size-4" />
                            Nyalakan ulang kamera
                        </BaseButton>
                        <BaseButton variant="danger" size="sm" :loading="live.connecting" @click="confirmEndOpen = true">
                            <Square class="size-4" />
                            Selesai kerja
                        </BaseButton>
                    </div>
                </aside>
            </section>

            <!-- Bilah kendali: pilih site, cari staf, atur tampilan -->
            <div class="flex flex-wrap items-center gap-3 rounded-xl border border-base-800 bg-base-900 p-2 shadow-(--shadow-card)">
                <div
                    v-if="sites.length > 1"
                    class="-m-0.5 flex min-w-0 flex-1 basis-full gap-1 overflow-x-auto p-0.5 lg:basis-auto"
                    role="radiogroup"
                    aria-label="Site yang ditonton"
                >
                    <button
                        v-for="option in [{ id: ALL_SITES, name: 'Semua site', live_count: totalLive }, ...sites]"
                        :key="option.id"
                        type="button"
                        role="radio"
                        :aria-checked="selectedSiteId === option.id"
                        :disabled="live.isBroadcasting || live.connecting"
                        class="inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent-400 disabled:cursor-not-allowed disabled:opacity-50"
                        :class="
                            selectedSiteId === option.id
                                ? 'bg-base-50 text-base-950 shadow-(--shadow-card)'
                                : 'text-base-300 hover:bg-base-850 hover:text-base-50'
                        "
                        @click="selectSite(option.id)"
                    >
                        <LayoutGrid v-if="option.id === ALL_SITES" class="size-4" />
                        {{ option.name }}
                        <span
                            class="min-w-5 rounded-full px-1.5 py-px text-center font-mono text-[11px] tabular-nums"
                            :class="
                                selectedSiteId === option.id
                                    ? 'bg-base-950/20'
                                    : option.live_count
                                      ? 'bg-accent-500/12 text-accent-400'
                                      : 'bg-base-850 text-base-500'
                            "
                        >
                            {{ option.live_count ?? 0 }}
                        </span>
                    </button>
                </div>
                <p v-else class="flex-1 px-2 text-sm font-medium text-base-100">{{ ownSiteName ?? sites[0]?.name }}</p>

                <div v-if="!auth.seesOnlySelf" class="relative w-full sm:w-72">
                    <label for="live-search" class="sr-only">Cari staf yang sedang siaran</label>
                    <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                    <input
                        id="live-search"
                        ref="searchInput"
                        v-model="search"
                        type="search"
                        role="combobox"
                        autocomplete="off"
                        placeholder="Cari nama staf yang live…"
                        class="field-control !py-2 pr-9 pl-9"
                        aria-controls="live-search-results"
                        :aria-expanded="searchOpen"
                        :aria-activedescendant="
                            searchOpen && searchShown[searchActive] ? `live-search-${searchShown[searchActive].identity}` : undefined
                        "
                        @focus="searchOpen = !!search.trim()"
                        @blur="searchOpen = false"
                        @keydown="onSearchKeydown"
                    />
                    <kbd
                        v-if="!search"
                        class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded border border-base-700 px-1.5 font-mono text-[11px] text-base-500"
                        aria-hidden="true"
                        >/</kbd
                    >

                    <div
                        v-if="searchOpen"
                        class="absolute inset-x-0 top-full z-30 mt-1.5 overflow-hidden rounded-xl border border-base-800 bg-base-900 shadow-(--shadow-raised)"
                    >
                        <ul
                            v-if="searchShown.length"
                            id="live-search-results"
                            role="listbox"
                            aria-label="Staf yang sedang siaran"
                            class="max-h-80 overflow-y-auto py-1"
                        >
                            <li
                                v-for="(participant, index) in searchShown"
                                :id="`live-search-${participant.identity}`"
                                :key="participant.identity"
                                role="option"
                                :aria-selected="index === searchActive"
                                class="flex cursor-pointer items-center gap-3 px-3 py-2"
                                :class="index === searchActive ? 'bg-base-850' : 'hover:bg-base-850'"
                                @mousedown.prevent="openSearchResult(participant)"
                                @mousemove="searchActive = index"
                            >
                                <span class="beacon shrink-0" />
                                <span class="min-w-0 flex-1">
                                    <span class="block truncate text-sm font-semibold text-base-50">{{
                                        participant.name || participant.identity
                                    }}</span>
                                    <span class="block truncate text-xs text-base-500">
                                        <template v-if="searchSiteName(participant)">{{ searchSiteName(participant) }} · </template>live
                                        {{ formatElapsed(liveSince(participant), now) }}
                                    </span>
                                </span>
                                <span
                                    v-if="statusOf(participant)"
                                    class="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                                    :class="workStatus(statusOf(participant)).chip"
                                    >{{ workStatus(statusOf(participant)).label }}</span
                                >
                            </li>
                        </ul>
                        <p v-else id="live-search-results" class="px-3 py-3 text-sm text-base-400">
                            Tidak ada staf live bernama “{{ search.trim() }}”.
                        </p>
                        <p
                            v-if="searchResults.length > searchShown.length"
                            class="border-t border-base-800 px-3 py-2 text-xs text-base-500"
                        >
                            {{ searchResults.length - searchShown.length }} lainnya tampil di dinding video.
                        </p>
                    </div>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                    <BaseButton v-if="listeningCount" variant="outline" size="sm" @click="live.muteAll()">
                        <VolumeX class="size-4" />
                        Bisukan semua ({{ listeningCount }})
                    </BaseButton>
                    <p
                        v-if="compact"
                        class="rounded-lg border border-base-800 bg-base-850 px-3 py-1.5 text-xs text-base-400"
                        title="Lebih dari 4 staf live: semua tampil kecil, klik untuk memperbesar"
                    >
                        Tampilan ringkas · klik staf untuk memperbesar
                    </p>
                    <div
                        v-else
                        class="flex rounded-lg border border-base-800 bg-base-850 p-0.5"
                        role="radiogroup"
                        aria-label="Jumlah staf per tampilan"
                    >
                        <button
                            v-for="count in LAYOUTS"
                            :key="count"
                            type="button"
                            role="radio"
                            :aria-checked="layout === count"
                            class="rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors focus-visible:outline-2 focus-visible:outline-accent-400"
                            :class="
                                layout === count ? 'bg-base-900 text-base-50 shadow-(--shadow-card)' : 'text-base-400 hover:text-base-100'
                            "
                            @click="layout = count"
                        >
                            {{ count }} layar
                        </button>
                    </div>
                    <div
                        class="flex items-center gap-1 rounded-lg border border-base-800 bg-base-850 p-0.5"
                        role="radiogroup"
                        aria-label="Ukuran kamera"
                    >
                        <span class="px-1.5 text-[11px] text-base-500 font-semibold">Kamera</span>
                        <button
                            v-for="option in CAMERA_SIZES"
                            :key="option.value"
                            type="button"
                            role="radio"
                            :aria-checked="cameraSize === option.value"
                            class="rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent-400"
                            :class="
                                cameraSize === option.value
                                    ? 'bg-base-900 text-base-50 shadow-(--shadow-card)'
                                    : 'text-base-400 hover:text-base-100'
                            "
                            @click="cameraSize = option.value"
                        >
                            {{ option.label }}
                        </button>
                    </div>
                    <BaseButton
                        variant="outline"
                        size="sm"
                        :aria-pressed="swapped"
                        :title="swapped ? 'Kamera di kiri' : 'Layar di kiri, kamera di kanan'"
                        @click="swapped = !swapped"
                    >
                        <ArrowLeftRight class="size-4" />
                        {{ swapped ? 'Kamera | Layar' : 'Layar | Kamera' }}
                    </BaseButton>
                    <BaseButton variant="outline" size="sm" @click="toggleFullscreen">
                        <Maximize class="size-4" />
                        Layar penuh
                    </BaseButton>
                </div>
            </div>

            <div class="grid items-start gap-5" :class="!auth.seesOnlySelf && 'xl:grid-cols-[minmax(0,1fr)_20rem]'">
                <!-- Dinding video (tidak ada untuk staf biasa: hanya melihat dirinya sendiri) -->
                <section
                    v-if="!auth.seesOnlySelf"
                    ref="wallEl"
                    aria-labelledby="live-wall-title"
                    :class="isFullscreen && 'overflow-auto bg-base-950 p-4'"
                >
                    <!-- Ruang leader: terpisah dari dinding staf, hanya untuk admin & root. -->
                    <div
                        v-if="canWatchLeaders && leaderParticipants.length"
                        class="mb-6"
                        aria-labelledby="live-leaders-title"
                        role="region"
                    >
                        <h2
                            id="live-leaders-title"
                            class="mb-3 flex items-center gap-2 font-display text-lg font-bold text-base-50 tracking-[-0.015em]"
                        >
                            Leader
                            <span class="font-mono text-sm font-medium text-base-500 tabular-nums">{{ leaderParticipants.length }}</span>
                            <span class="text-xs font-normal text-base-500">· hanya terlihat oleh admin & root</span>
                        </h2>
                        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4">
                            <div v-for="participant in leaderParticipants" :key="participant.identity" class="relative">
                                <button
                                    type="button"
                                    class="tile-button block w-full rounded-xl text-left focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-none"
                                    :aria-label="`Perbesar ${participant.name || participant.identity}`"
                                    @click="focusedIdentity = participant.identity"
                                >
                                    <LiveMiniTile
                                        :name="participant.name || participant.identity"
                                        site="Leader"
                                        :screen-track="trackOf(participant, SCREEN_SOURCE)"
                                        :camera-track="trackOf(participant, CAMERA_SOURCE)"
                                        :status="statusOf(participant)"
                                        :since="liveSince(participant)"
                                        :speaking="participant.isSpeaking"
                                        :transport="transportOf(participant)"
                                    />
                                </button>
                                <LiveAudioButton
                                    class="!absolute top-1.5 right-1.5"
                                    :name="participant.name || participant.identity"
                                    :mic-state="micStateOf(participant)"
                                    :listening="isListening(participant)"
                                    :speaking="participant.isSpeaking"
                                    @toggle="live.toggleListen(participant.identity)"
                                />
                            </div>
                        </div>
                    </div>

                    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <h2
                            id="live-wall-title"
                            class="flex items-center gap-2 font-display text-lg font-bold text-base-50 tracking-[-0.015em]"
                        >
                            Sedang live
                            <span class="font-mono text-sm font-medium text-base-500 tabular-nums">{{ wallParticipants.length }}</span>
                            <span v-if="isFullscreen && !isAllSites" class="text-sm font-normal text-base-500"
                                >· {{ siteNames[selectedSiteId] }}</span
                            >
                        </h2>
                        <div class="flex flex-wrap items-center gap-2">
                            <!-- Jalur video: klik untuk menyaring (mis. hanya yang lewat TCP). -->
                            <div
                                v-if="transportCounts.udp || transportCounts.tcp"
                                class="inline-flex overflow-hidden rounded-full border border-base-700 text-[12px] tabular-nums font-semibold"
                                role="group"
                                aria-label="Saring menurut jalur video"
                            >
                                <button
                                    v-for="entry in [
                                        { key: 'udp', label: 'UDP', on: 'bg-st-online/15 text-st-online' },
                                        { key: 'tcp', label: 'TCP', on: 'bg-warning-500/15 text-warning-400' },
                                    ]"
                                    :key="entry.key"
                                    type="button"
                                    class="px-2.5 py-1 transition-colors"
                                    :class="[
                                        transportFilter === entry.key ? entry.on : 'text-base-400 hover:text-base-200',
                                        entry.key === 'tcp' && transportCounts.tcp && transportFilter !== 'tcp' && 'text-warning-400',
                                    ]"
                                    :aria-pressed="transportFilter === entry.key"
                                    :title="
                                        entry.key === 'tcp'
                                            ? 'Video lewat TCP: UDP diblokir (biasanya VPN/firewall). Berat untuk server.'
                                            : 'Video lewat UDP (normal)'
                                    "
                                    @click="transportFilter = transportFilter === entry.key ? null : entry.key"
                                >
                                    {{ entry.label }} {{ transportCounts[entry.key] }}
                                </button>
                            </div>
                            <button
                                v-if="statusFilter"
                                type="button"
                                class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-semibold"
                                :class="workStatus(statusFilter).chip"
                                @click="statusFilter = null"
                            >
                                {{ workStatus(statusFilter).label }}
                                <X class="size-3" aria-hidden="true" />
                                <span class="sr-only">Hapus saringan status</span>
                            </button>
                            <BaseButton v-if="isFullscreen" variant="outline" size="sm" @click="toggleFullscreen">
                                <Minimize class="size-4" />
                                Keluar layar penuh
                            </BaseButton>
                        </div>
                    </div>

                    <div
                        v-if="live.mode === 'idle' || !wallParticipants.length"
                        class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-base-700 bg-base-900/60 px-6 py-14 text-center"
                    >
                        <span class="flex size-12 items-center justify-center rounded-xl bg-base-850 text-base-400">
                            <Video class="size-6" />
                        </span>
                        <div>
                            <p class="font-medium text-base-100">
                                <template v-if="live.mode === 'idle'">
                                    {{ live.connecting ? 'Menghubungkan ke siaran…' : 'Belum terhubung ke siaran' }}
                                </template>
                                <template v-else-if="live.remoteParticipants.length"
                                    >Tidak ada staf live yang cocok dengan saringan</template
                                >
                                <template v-else>Belum ada staf yang mulai kerja</template>
                            </p>
                            <p v-if="!live.connecting" class="mx-auto mt-1 max-w-md text-sm text-pretty text-base-500">
                                <template v-if="live.mode === 'idle'"
                                    >Pilih site di atas untuk melihat siapa saja yang sedang bekerja.</template
                                >
                                <template v-else-if="live.remoteParticipants.length"
                                    >Hapus pencarian atau saringan status untuk melihat semua.</template
                                >
                                <template v-else>Layar & kamera staf muncul di sini begitu mereka menekan Mulai kerja.</template>
                            </p>
                        </div>
                    </div>

                    <!-- Bingkai dibuat lebar: adaptiveStream memilih layer resolusi dari
                         ukuran video, jadi bingkai besar = gambar lebih tajam. -->
                    <!-- Tombol suara SEJAJAR (bukan di dalam) tombol perbesar: tombol
                         bersarang tidak sah di HTML dan membingungkan pembaca layar. -->
                    <TransitionGroup v-else-if="compact" tag="div" name="tile" class="grid gap-3" :class="wallGridClass">
                        <div
                            v-for="participant in visibleParticipants"
                            :key="participant.identity"
                            class="relative rounded-xl"
                            :class="attentionRing(participant)"
                        >
                            <button
                                type="button"
                                class="tile-button block w-full rounded-xl text-left focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-none"
                                :aria-label="`Perbesar ${participant.name || participant.identity}`"
                                @click="focusedIdentity = participant.identity"
                            >
                                <LiveMiniTile
                                    :name="participant.name || participant.identity"
                                    :site="siteNameOf(participant)"
                                    :screen-track="trackOf(participant, SCREEN_SOURCE)"
                                    :camera-track="trackOf(participant, CAMERA_SOURCE)"
                                    :status="statusOf(participant)"
                                    :since="liveSince(participant)"
                                    :speaking="participant.isSpeaking"
                                    :transport="transportOf(participant)"
                                />
                            </button>
                            <LiveAudioButton
                                class="!absolute top-1.5 right-1.5"
                                :name="participant.name || participant.identity"
                                :mic-state="micStateOf(participant)"
                                :listening="isListening(participant)"
                                :speaking="participant.isSpeaking"
                                @toggle="live.toggleListen(participant.identity)"
                            />
                        </div>
                    </TransitionGroup>
                    <TransitionGroup v-else tag="div" name="tile" class="grid gap-4" :class="wallGridClass">
                        <div
                            v-for="participant in visibleParticipants"
                            :key="participant.identity"
                            class="relative rounded-xl"
                            :class="attentionRing(participant)"
                        >
                            <button
                                type="button"
                                class="tile-button block w-full rounded-xl text-left focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-none"
                                :aria-label="`Perbesar ${participant.name || participant.identity}`"
                                @click="focusedIdentity = participant.identity"
                            >
                                <LivePairTile
                                    :name="participant.name || participant.identity"
                                    :site="siteNameOf(participant)"
                                    :screen-track="trackOf(participant, SCREEN_SOURCE)"
                                    :camera-track="trackOf(participant, CAMERA_SOURCE)"
                                    :status="statusOf(participant)"
                                    :since="liveSince(participant)"
                                    :quality="participant.connectionQuality"
                                    :transport="transportOf(participant)"
                                    :swapped="swapped"
                                    :camera-size="cameraSize"
                                    :speaking="participant.isSpeaking"
                                    action-inset
                                />
                            </button>
                            <LiveAudioButton
                                class="!absolute top-1 right-2"
                                :name="participant.name || participant.identity"
                                :mic-state="micStateOf(participant)"
                                :listening="isListening(participant)"
                                :speaking="participant.isSpeaking"
                                @toggle="live.toggleListen(participant.identity)"
                            />
                        </div>
                    </TransitionGroup>

                    <div
                        v-if="pageCount > 1"
                        class="mt-4 flex items-center justify-center gap-1 font-mono text-xs text-base-400 tabular-nums"
                    >
                        <BaseButton variant="ghost" size="sm" :disabled="page === 0" aria-label="Halaman sebelumnya" @click="page--">
                            <ChevronLeft class="size-4" />
                        </BaseButton>
                        {{ page + 1 }} / {{ pageCount }}
                        <BaseButton
                            variant="ghost"
                            size="sm"
                            :disabled="page >= pageCount - 1"
                            aria-label="Halaman berikutnya"
                            @click="page++"
                        >
                            <ChevronRight class="size-4" />
                        </BaseButton>
                    </div>
                </section>

                <!-- Panel status: semua staf, termasuk yang belum mulai kerja -->
                <aside
                    aria-labelledby="live-status-title"
                    class="overflow-hidden rounded-xl border border-base-800 bg-base-900 shadow-(--shadow-card) xl:sticky xl:top-16"
                >
                    <div class="border-b border-base-800 px-4 py-3">
                        <h2
                            id="live-status-title"
                            class="flex items-center justify-between font-display text-base font-bold text-base-50 tracking-[-0.015em]"
                        >
                            Status staf
                            <span class="font-mono text-xs font-medium text-base-500 tabular-nums">{{ siteRoster.length }} staf</span>
                        </h2>
                        <div v-if="statusCounts.length" class="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Saring menurut status">
                            <button
                                v-for="entry in statusCounts"
                                :key="entry.key"
                                type="button"
                                :aria-pressed="statusFilter === entry.key"
                                class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-accent-400 font-semibold"
                                :class="
                                    statusFilter === entry.key
                                        ? entry.chip
                                        : 'border-base-800 text-base-400 hover:border-base-600 hover:text-base-100'
                                "
                                @click="statusFilter = statusFilter === entry.key ? null : entry.key"
                            >
                                <span class="led" :class="entry.led" />
                                {{ entry.label }} {{ entry.count }}
                            </button>
                        </div>
                    </div>

                    <!-- Status leader: hanya untuk admin & root. -->
                    <div v-if="canWatchLeaders && leadersRoster.length" class="border-b border-base-800">
                        <p class="eyebrow flex items-center justify-between px-4 pt-3 pb-1">
                            Leader
                            <span class="font-mono text-[10.5px] text-base-500 tabular-nums">{{ leadersLive }} live</span>
                        </p>
                        <ul class="max-h-48 divide-y divide-base-800 overflow-y-auto">
                            <li v-for="leader in leadersRoster" :key="leader.user_id">
                                <button
                                    type="button"
                                    class="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-base-850 focus-visible:bg-base-850 focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
                                    :disabled="!sessionByIdentity[leader.participant_identity]"
                                    @click="focusStaff(leader)"
                                >
                                    <span class="led" :class="workStatus(leader.status).led" />
                                    <span class="min-w-0 flex-1">
                                        <span class="flex items-center gap-1.5">
                                            <span class="truncate text-sm font-medium text-base-100">{{ leader.name }}</span>
                                            <LoginDeviceIcon :device="leader.login_device" />
                                        </span>
                                        <span class="block truncate text-xs text-base-500">
                                            <template v-if="leader.started_at">live {{ formatElapsed(leader.started_at, now) }}</template>
                                            <template v-else>belum mulai kerja</template>
                                        </span>
                                    </span>
                                    <span
                                        class="shrink-0 rounded-full border px-1.5 py-0.5 text-[11px] font-semibold"
                                        :class="workStatus(leader.status).chip"
                                    >
                                        {{ workStatus(leader.status).label }}
                                    </span>
                                </button>
                            </li>
                        </ul>
                    </div>

                    <p v-if="!filteredRoster.length" class="px-4 py-8 text-center text-sm text-base-500">
                        {{ siteRoster.length ? 'Tidak ada staf yang cocok.' : 'Belum ada staf yang terdaftar untuk Live Kerja.' }}
                    </p>
                    <ul v-else class="max-h-[32rem] divide-y divide-base-800 overflow-y-auto xl:max-h-[calc(100dvh-14rem)]">
                        <li v-for="staff in filteredRoster" :key="staff.user_id">
                            <button
                                type="button"
                                class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-base-850 focus-visible:bg-base-850 focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
                                :disabled="!sessionByIdentity[staff.participant_identity]"
                                @click="focusStaff(staff)"
                            >
                                <span
                                    class="led"
                                    :class="[workStatus(staff.status).led, staff.status === 'alert' && 'motion-safe:animate-pulse']"
                                />
                                <span class="min-w-0 flex-1">
                                    <span class="flex items-center gap-1.5">
                                        <span class="truncate text-sm font-medium text-base-100">{{ staff.name }}</span>
                                        <LoginDeviceIcon :device="staff.login_device" />
                                    </span>
                                    <span class="block truncate text-xs text-base-500">
                                        <template v-if="isAllSites"
                                            >{{ siteNames[staff.organization_id]
                                            }}<template v-if="staff.started_at"> · </template></template
                                        >
                                        <template v-if="staff.started_at">live {{ formatElapsed(staff.started_at, now) }}</template>
                                        <template v-else-if="!isAllSites">belum mulai kerja</template>
                                    </span>
                                </span>
                                <span
                                    class="shrink-0 rounded-full border px-1.5 py-0.5 text-[11px] font-semibold"
                                    :class="workStatus(staff.status).chip"
                                >
                                    {{ workStatus(staff.status).label }}
                                </span>
                            </button>
                        </li>
                    </ul>
                </aside>
            </div>
        </div>

        <DialogRoot :open="!!focused" @update:open="(v) => !v && (focusedIdentity = null)">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm" />
                <DialogContent
                    @keydown.left.prevent="focusStep(-1)"
                    @keydown.right.prevent="focusStep(1)"
                    class="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[min(110rem,calc((100dvh-9rem)*32/9))] -translate-x-1/2 -translate-y-1/2 overflow-auto focus:outline-none"
                >
                    <div class="mb-3 flex flex-wrap items-center justify-between gap-4">
                        <div class="flex min-w-0 items-center gap-3">
                            <div class="flex items-center gap-1">
                                <button
                                    type="button"
                                    class="flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-accent-400 disabled:opacity-30"
                                    aria-label="Staf sebelumnya"
                                    :disabled="focusList.length < 2"
                                    @click="focusStep(-1)"
                                >
                                    <ChevronLeft class="size-5" />
                                </button>
                                <button
                                    type="button"
                                    class="flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-accent-400 disabled:opacity-30"
                                    aria-label="Staf berikutnya"
                                    :disabled="focusList.length < 2"
                                    @click="focusStep(1)"
                                >
                                    <ChevronRight class="size-5" />
                                </button>
                            </div>
                            <div class="min-w-0">
                                <DialogTitle class="truncate font-display text-xl font-extrabold tracking-[-0.025em] text-white">
                                    {{ focused?.name || focused?.identity }}
                                </DialogTitle>
                                <DialogDescription class="text-xs text-white/60 tabular-nums">
                                    {{ focusPosition }} · live sejak
                                    {{ focusedSince ? new Date(focusedSince).toLocaleTimeString('id-ID') : '—' }} · ← → untuk pindah staf
                                </DialogDescription>
                            </div>
                        </div>
                        <div class="flex items-center gap-2">
                            <LiveAudioButton
                                v-if="focused"
                                :name="focused.name || focused.identity"
                                :mic-state="micStateOf(focused)"
                                :listening="isListening(focused)"
                                :speaking="focused.isSpeaking"
                                @toggle="live.toggleListen(focused.identity)"
                            />
                            <BaseButton variant="outline" size="sm" :aria-pressed="swapped" @click="swapped = !swapped">
                                <ArrowLeftRight class="size-4" />
                                Tukar
                            </BaseButton>
                            <button
                                type="button"
                                class="flex size-8 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-accent-400"
                                aria-label="Tutup"
                                @click="focusedIdentity = null"
                            >
                                <X class="size-5" />
                            </button>
                        </div>
                    </div>
                    <!-- Track yang sama terpasang di ubin grid & di sini; adaptiveStream
                         memakai elemen terbesar, jadi tampilan ini meminta layer tertinggi. -->
                    <LivePairTile
                        v-if="focused"
                        :name="focused.name || focused.identity"
                        :site="siteNames[live.participantSites[focused.identity]] ?? null"
                        :screen-track="trackOf(focused, SCREEN_SOURCE)"
                        :camera-track="trackOf(focused, CAMERA_SOURCE)"
                        :status="statusOf(focused)"
                        :since="focusedSince"
                        :quality="focused.connectionQuality"
                        :transport="transportOf(focused)"
                        :swapped="swapped"
                        :camera-size="cameraSize"
                        :speaking="focused.isSpeaking"
                        large
                    />
                </DialogContent>
            </DialogPortal>
        </DialogRoot>

        <ConfirmDialog
            v-model:open="confirmStartOpen"
            :title="canShareScreen ? 'Mulai kerja & bagikan seluruh layar?' : 'Mulai kerja & nyalakan kamera?'"
            :description="
                canShareScreen
                    ? 'Setelah menekan Mulai kerja, pilih tab Entire screen (Seluruh layar) lalu tekan Share. Layar, kamera, dan suara mikrofon Anda disiarkan ke atasan Anda (leader, admin, dan admin site) sampai Anda menekan Selesai kerja. Mikrofon bisa Anda bisukan kapan saja. Tidak direkam. Jam mulai, istirahat, dan selesai kerja tercatat di log kerja.'
                    : 'Kamera dan suara mikrofon Anda disiarkan ke atasan Anda (leader, admin, dan admin site) sampai Anda menekan Selesai kerja. Mikrofon bisa Anda bisukan kapan saja. Tidak direkam. Jam mulai, istirahat, dan selesai kerja tercatat di log kerja.'
            "
            confirm-label="Mulai kerja"
            confirm-variant="primary"
            :loading="live.connecting"
            @confirm="startWork"
        />

        <ConfirmDialog
            v-model:open="confirmEndOpen"
            title="Selesai kerja?"
            description="Siaran kamera, layar, dan mikrofon Anda dihentikan, dan jam selesai kerja dicatat."
            confirm-label="Selesai kerja"
            :loading="live.connecting"
            @confirm="endWork"
        />
    </div>
</template>

<style scoped>
/* Ubin terangkat saat disorot -- isyarat bisa diklik untuk diperbesar */
.tile-button {
    transition:
        transform 200ms cubic-bezier(0.22, 1, 0.36, 1),
        box-shadow 200ms;
}

.tile-button:hover {
    transform: translateY(-3px);
    box-shadow: var(--shadow-raised);
}

/* Staf baru mulai kerja: ubin muncul halus, yang selesai memudar */
.tile-enter-active,
.tile-leave-active {
    transition:
        opacity 300ms,
        transform 300ms cubic-bezier(0.22, 1, 0.36, 1);
}

.tile-enter-from,
.tile-leave-to {
    opacity: 0;
    transform: scale(0.96);
}

@media (prefers-reduced-motion: reduce) {
    .tile-button,
    .tile-enter-active,
    .tile-leave-active {
        transition: none;
    }

    .tile-button:hover {
        transform: none;
    }
}
</style>
