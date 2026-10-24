<script setup>
import {
    ArrowLeftRight,
    ChevronLeft,
    ChevronRight,
    Coffee,
    Download,
    LayoutGrid,
    Maximize,
    Minimize,
    MonitorUp,
    MonitorX,
    Play,
    RefreshCw,
    Search,
    Smartphone,
    Square,
    Video,
    X,
} from '@lucide/vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import LivePairTile from '@/components/live/LivePairTile.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import Readout from '@/components/ui/Readout.vue'
import { formatElapsed, useNow } from '@/composables/useNow'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { ATTENTION_STATUSES, WORK_STATUS, workStatus } from '@/lib/workStatus'
import { useAuthStore } from '@/stores/auth'
import { CAMERA_SOURCE, SCREEN_SOURCE, canShareScreen, useLiveStore } from '@/stores/live'

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

const canBroadcast = computed(() => auth.hasPermission('live.broadcast') && !!auth.user?.organization_id)
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

// ---- Status semua staf (dari server), diperbarui berkala.
const roster = ref([])
const sessionByIdentity = ref({})
let statusTimer = null

async function loadStatus() {
    try {
        const response = await api.get('/live/overview')
        const data = response.data.data
        sites.value = data.sites
        roster.value = data.roster
        sessionByIdentity.value = Object.fromEntries(data.items.map((session) => [session.participant_identity, session]))
    } catch {
        // Status & durasi tidak wajib -- tapi daftar site wajib ada supaya
        // video tetap bisa ditonton (mis. server belum punya /live/overview).
        if (!sites.value.length) {
            const response = await api.get('/live/sites').catch(() => null)
            sites.value = response?.data.data ?? []
        }
    }
}

watch(
    () => live.remoteParticipants.map((p) => p.identity),
    (identities) => {
        if (identities.some((id) => !(id in sessionByIdentity.value))) loadStatus()
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

const wallParticipants = computed(() =>
    live.remoteParticipants.filter(
        (participant) =>
            (!statusFilter.value || statusOf(participant) === statusFilter.value) &&
            matchesSearch(participant.name || participant.identity),
    ),
)

// Hanya peserta di halaman yang tampil yang di-subscribe (lihat
// live.setVisibleParticipants), jadi menonton 100+ staf tidak berarti
// mengunduh 100+ video sekaligus.
const pageCount = computed(() => Math.max(1, Math.ceil(wallParticipants.value.length / layout.value)))
const visibleParticipants = computed(() => wallParticipants.value.slice(page.value * layout.value, (page.value + 1) * layout.value))
const wallGridClass = computed(() => (layout.value === 4 ? '2xl:grid-cols-2' : 'grid-cols-1'))

watch(visibleParticipants, (participants) => live.setVisibleParticipants(participants.map((p) => p.identity)), { immediate: true })
watch(pageCount, (count) => {
    if (page.value >= count) page.value = count - 1
})
watch([search, statusFilter], () => (page.value = 0))

function trackOf(participant, source) {
    return participant.getTrackPublication(source)?.track ?? null
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
const ownSiteName = computed(() => siteNames.value[live.organizationId] ?? null)
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
    const response = await api.get('/live/sessions', { params: { organization_id: auth.user?.organization_id ?? undefined } })
    mySession.value = response.data.data.my_session
}

// APK Live: browser HP menghentikan kamera begitu staf pindah aplikasi atau
// layar mati, APK-nya tidak (foreground service kamera, lihat android-live-app).
const liveApp = ref(null)
const downloadingApp = ref(false)

async function loadLiveApp() {
    const response = await api.get('/live/app')
    liveApp.value = response.data.data
}

// Tautan unduh bertanda tangan & cuma berlaku 30 menit -- minta yang baru
// tepat saat tombol ditekan, bukan memakai yang dimuat saat halaman dibuka.
async function downloadLiveApp() {
    downloadingApp.value = true
    try {
        await loadLiveApp()
        if (liveApp.value?.download_url) window.location.href = liveApp.value.download_url
    } catch (err) {
        toast.error('Gagal mengunduh APK Live', err.response?.data?.message)
    } finally {
        downloadingApp.value = false
    }
}

/** Tonton satu site, atau ALL_SITES = semua site sekaligus (satu koneksi per site). */
async function selectSite(siteId) {
    if (live.isBroadcasting) return // siaran terkunci ke site sendiri
    selectedSiteId.value = siteId
    page.value = 0
    try {
        await live.watchSites(siteId === ALL_SITES ? sites.value.map((site) => site.id) : [siteId])
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
        selectedSiteId.value = live.organizationId
        mySession.value = null
        loadStatus()
        toast.success(
            'Mulai kerja',
            canShareScreen ? 'Layar & kamera Anda sedang disiarkan.' : 'Kamera Anda sedang disiarkan ke rekan se-site',
        )
    } catch (err) {
        const cameraMessages = {
            NotAllowedError: 'Izin kamera ditolak. Izinkan kamera untuk situs ini di pengaturan browser, lalu coba lagi.',
            NotFoundError: 'Kamera tidak ditemukan di perangkat ini.',
            NotReadableError: 'Kamera sedang dipakai aplikasi lain (Zoom, Teams, tab lain). Tutup dulu, lalu coba lagi.',
        }
        toast.error('Gagal memulai siaran', cameraMessages[err.name] ?? err.response?.data?.message ?? err.message)
        // startWork() memutus koneksi tonton yang lama -- sambung lagi supaya
        // staf tetap melihat rekan-rekannya walau siarannya sendiri gagal.
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
    statusTimer = setInterval(loadStatus, 15_000)

    try {
        await loadStatus()
        if (canBroadcast.value) await loadMySession()
        if (canBroadcast.value) loadLiveApp().catch(() => {})
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
    clearInterval(statusTimer)
})
</script>

<template>
    <div>
        <!-- Tanpa judul besar: layar ini untuk memantau, ruang vertikal dipakai video.
             Judul tetap ada untuk pembaca layar. -->
        <h1 class="sr-only">Live Kerja</h1>
        <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-base-800 px-4 pt-5 pb-4 sm:px-8">
            <div class="flex flex-wrap gap-x-8 gap-y-3">
                <Readout
                    label="Sedang live"
                    :value="live.mode === 'idle' ? '—' : live.remoteParticipants.length"
                    :led="live.remoteParticipants.length ? 'danger' : 'muted'"
                />
                <Readout label="Working" :value="countOf(['working'])" :led="countOf(['working']) ? 'accent' : 'muted'" />
                <Readout label="Break" :value="countOf(['break'])" />
                <Readout
                    label="Perlu perhatian"
                    :value="countOf(ATTENTION_STATUSES)"
                    :led="countOf(ATTENTION_STATUSES) ? 'warning' : 'muted'"
                />
                <Readout v-if="live.isBroadcasting" label="Siaran Anda" :value="myStatusMeta?.label ?? 'Aktif'" led="danger" />
            </div>
            <div class="flex flex-wrap items-center gap-2">
                <template v-if="canBroadcast">
                    <BaseButton v-if="!live.isBroadcasting" :loading="live.connecting" @click="confirmStartOpen = true">
                        <Play class="size-4" />
                        {{ mySession ? 'Lanjutkan siaran' : 'Mulai kerja' }}
                    </BaseButton>
                </template>
            </div>
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
                v-if="canBroadcast && liveApp && !canShareScreen"
                class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-base-800 bg-base-900 px-4 py-3 text-sm shadow-(--shadow-card)"
            >
                <span class="flex items-start gap-3 text-pretty text-base-300">
                    <Smartphone class="mt-0.5 size-4 shrink-0 text-accent-400" />
                    <span>
                        Kerja dari HP? Pasang <strong class="text-base-50">APK Live</strong> supaya siaran tetap jalan saat Anda pindah
                        aplikasi atau layar mati. Di browser, kamera berhenti setiap kali halaman ini ditinggalkan.
                    </span>
                </span>
                <BaseButton size="sm" variant="outline" :loading="downloadingApp" @click="downloadLiveApp">
                    <Download class="size-4" />
                    Unduh APK Live v{{ liveApp.version }}
                </BaseButton>
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
                    :swapped="swapped"
                    :camera-size="cameraSize"
                    mirror-camera
                />

                <aside class="flex flex-col gap-5 px-1 pb-1 xl:py-2 xl:pr-2">
                    <div>
                        <p class="eyebrow flex items-center gap-2">
                            <span class="led text-danger-400" />
                            Sedang disiarkan<template v-if="ownSiteName"> · {{ ownSiteName }}</template>
                        </p>
                        <p class="mt-2 font-mono text-4xl font-medium tracking-tight text-base-50 tabular-nums sm:text-[2.75rem]">
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
                    </dl>

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
                                ? 'bg-accent-500 text-base-950'
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
                                      ? 'bg-danger-500/10 text-danger-400'
                                      : 'bg-base-850 text-base-500'
                            "
                        >
                            {{ option.live_count ?? 0 }}
                        </span>
                    </button>
                </div>
                <p v-else class="flex-1 px-2 text-sm font-medium text-base-100">{{ ownSiteName ?? sites[0]?.name }}</p>

                <label class="relative w-full sm:w-56">
                    <span class="sr-only">Cari staf</span>
                    <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                    <input v-model="search" type="search" placeholder="Cari staf…" class="field-control !py-2 pl-9" />
                </label>

                <div class="flex flex-wrap items-center gap-2">
                    <div
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
                        <span class="px-1.5 font-mono text-[10.5px] tracking-[0.1em] text-base-500 uppercase">Kamera</span>
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

            <div class="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
                <!-- Dinding video -->
                <section ref="wallEl" aria-labelledby="live-wall-title" :class="isFullscreen && 'overflow-auto bg-base-950 p-4'">
                    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <h2 id="live-wall-title" class="flex items-center gap-2 font-display text-lg font-semibold text-base-50">
                            Sedang live
                            <span class="font-mono text-sm font-medium text-base-500 tabular-nums">{{ wallParticipants.length }}</span>
                            <span v-if="isFullscreen && !isAllSites" class="text-sm font-normal text-base-500"
                                >· {{ siteNames[selectedSiteId] }}</span
                            >
                        </h2>
                        <div class="flex items-center gap-2">
                            <button
                                v-if="statusFilter"
                                type="button"
                                class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] tracking-[0.08em] uppercase"
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
                    <div v-else class="grid gap-4" :class="wallGridClass">
                        <button
                            v-for="participant in visibleParticipants"
                            :key="participant.identity"
                            type="button"
                            class="rounded-xl text-left transition-shadow hover:ring-2 hover:ring-accent-400/50 focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:outline-none"
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
                                :swapped="swapped"
                                :camera-size="cameraSize"
                            />
                        </button>
                    </div>

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
                            class="flex items-center justify-between font-display text-base font-semibold text-base-50"
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
                                class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10.5px] tracking-[0.06em] uppercase tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-accent-400"
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
                                    <span class="block truncate text-sm font-medium text-base-100">{{ staff.name }}</span>
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
                                    class="shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-[0.08em] uppercase"
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
                    class="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[min(110rem,calc((100dvh-9rem)*32/9))] -translate-x-1/2 -translate-y-1/2 overflow-auto focus:outline-none"
                >
                    <div class="mb-3 flex items-center justify-between gap-4">
                        <div class="min-w-0">
                            <DialogTitle class="sr-only">{{ focused?.name || focused?.identity }}</DialogTitle>
                            <DialogDescription class="font-mono text-xs text-white/70 tabular-nums">
                                Live sejak {{ focusedSince ? new Date(focusedSince).toLocaleTimeString('id-ID') : '—' }} · kualitas
                                menyesuaikan koneksi otomatis
                            </DialogDescription>
                        </div>
                        <div class="flex items-center gap-2">
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
                        :swapped="swapped"
                        :camera-size="cameraSize"
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
                    ? 'Setelah menekan Mulai kerja, pilih tab Entire screen (Seluruh layar) lalu tekan Share. Layar dan kamera Anda disiarkan ke rekan di site Anda sampai Anda menekan Selesai kerja. Tanpa suara, tidak direkam. Jam mulai, istirahat, dan selesai kerja tercatat di log kerja.'
                    : 'Kamera Anda menyala dan disiarkan ke rekan di site Anda sampai Anda menekan Selesai kerja. Tanpa suara, tidak direkam. Jam mulai, istirahat, dan selesai kerja tercatat di log kerja.'
            "
            confirm-label="Mulai kerja"
            confirm-variant="primary"
            :loading="live.connecting"
            @confirm="startWork"
        />

        <ConfirmDialog
            v-model:open="confirmEndOpen"
            title="Selesai kerja?"
            description="Siaran kamera dan layar Anda dihentikan, dan jam selesai kerja dicatat."
            confirm-label="Selesai kerja"
            :loading="live.connecting"
            @confirm="endWork"
        />
    </div>
</template>
