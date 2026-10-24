<script setup>
import {
    ArrowLeftRight,
    ChevronLeft,
    ChevronRight,
    Coffee,
    Download,
    Maximize,
    Minimize,
    MonitorUp,
    MonitorX,
    Play,
    RefreshCw,
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
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
import { formatElapsed, useNow } from '@/composables/useNow'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { WORK_STATUS, workStatus } from '@/lib/workStatus'
import { useAuthStore } from '@/stores/auth'
import { CAMERA_SOURCE, SCREEN_SOURCE, canShareScreen, useLiveStore } from '@/stores/live'

const auth = useAuthStore()
const live = useLiveStore()
const toast = useToast()
const now = useNow()

const sites = ref([])
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

// ---- Tata letak dinding: 1 / 2 / 4 staf per halaman, tukar layar <-> kamera.
// Disimpan per browser (kebiasaan tiap penonton beda), tidak wajib ada.
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
const layout = ref(LAYOUTS.includes(readPref('lacak_live_layout', 4)) ? readPref('lacak_live_layout', 4) : 4)
const swapped = ref(readPref('lacak_live_swapped', false) === true)
watch(layout, (value) => {
    writePref('lacak_live_layout', value)
    page.value = 0
})
watch(swapped, (value) => writePref('lacak_live_swapped', value))

// Hanya peserta di halaman yang tampil yang di-subscribe (lihat
// live.setVisibleParticipants), jadi menonton site dengan 100+ staf tidak
// berarti mengunduh 100+ video sekaligus.
const pageCount = computed(() => Math.max(1, Math.ceil(live.remoteParticipants.length / layout.value)))
const visibleParticipants = computed(() => live.remoteParticipants.slice(page.value * layout.value, (page.value + 1) * layout.value))
const wallGridClass = computed(() => (layout.value === 4 ? '2xl:grid-cols-2' : 'grid-cols-1'))

watch(visibleParticipants, (participants) => live.setVisibleParticipants(participants.map((p) => p.identity)), { immediate: true })
watch(pageCount, (count) => {
    if (page.value >= count) page.value = count - 1
})

function trackOf(participant, source) {
    return participant.getTrackPublication(source)?.track ?? null
}

// ---- Layar penuh untuk dinding pantau (mis. ditayangkan di monitor ruang kontrol).
const wallEl = ref(null)
const isFullscreen = ref(false)

function syncFullscreen() {
    isFullscreen.value = document.fullscreenElement === wallEl.value && !!wallEl.value
}

async function toggleFullscreen() {
    try {
        if (document.fullscreenElement) await document.exitFullscreen()
        else await wallEl.value?.requestFullscreen()
    } catch {
        toast.error('Layar penuh tidak tersedia', 'Browser ini tidak mengizinkan mode layar penuh.')
    }
}

// ---- Status staf se-site (dari server), diperbarui berkala.
const roster = ref([])
const sessionByIdentity = ref({})
let statusTimer = null

async function loadSiteStatus(siteId) {
    try {
        const response = await api.get('/live/sessions', { params: { organization_id: siteId } })
        if (siteId !== selectedSiteId.value) return
        roster.value = response.data.data.roster ?? []
        sessionByIdentity.value = Object.fromEntries(response.data.data.items.map((session) => [session.participant_identity, session]))
    } catch {
        // Hanya untuk status & durasi -- tanpa data ini video tetap tampil.
    }
}

watch(
    () => live.remoteParticipants.map((p) => p.identity),
    (identities) => {
        if (selectedSiteId.value && identities.some((id) => !(id in sessionByIdentity.value))) {
            loadSiteStatus(selectedSiteId.value)
        }
    },
)

function statusOf(participant) {
    return sessionByIdentity.value[participant.identity]?.status ?? null
}

// Kapan tiap rekan mulai kerja. Kalau belum termuat, pakai waktu bergabung
// ke room LiveKit sebagai perkiraan.
function liveSince(participant) {
    return sessionByIdentity.value[participant.identity]?.started_at ?? participant.joinedAt ?? null
}

const statusCounts = computed(() =>
    Object.keys(WORK_STATUS)
        .map((key) => ({ key, ...WORK_STATUS[key], count: roster.value.filter((staff) => staff.status === key).length }))
        .filter((entry) => entry.count),
)

const focusedSince = computed(() => (focused.value ? liveSince(focused.value) : null))
const currentSiteName = computed(() => sites.value.find((site) => site.id === live.organizationId)?.name ?? null)
const broadcastElapsed = computed(() => formatElapsed(live.broadcastStartedAt, now.value))
const myStatusMeta = computed(() => (live.myStatus ? workStatus(live.myStatus) : null))
// Dibaca ulang tiap detik (ikut `now`) -- kamera HP bisa menurunkan resolusi
// sendiri saat panas atau cahaya kurang.
const cameraSettings = computed(() => {
    now.value
    live.localCameraTrack
    return live.isBroadcasting ? live.localCameraSettings() : null
})

async function loadSites() {
    const response = await api.get('/live/sites')
    sites.value = response.data.data
}

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

async function selectSite(siteId) {
    if (live.isBroadcasting) return // siaran terkunci ke site sendiri
    selectedSiteId.value = siteId
    page.value = 0
    roster.value = []
    sessionByIdentity.value = {}
    loadSiteStatus(siteId)
    try {
        await live.watchSite(siteId)
    } catch (err) {
        toast.error('Gagal membuka siaran site', err.response?.data?.message ?? err.message)
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
        // NotAllowedError = staf menekan Batal di dialog pilih layar -- bukan error.
        if (err.name !== 'NotAllowedError') toast.error('Gagal membagikan layar', err.message)
    } finally {
        togglingScreen.value = false
        // Laporan status dikirim ~0,4 detik setelah track berubah.
        setTimeout(() => loadSiteStatus(selectedSiteId.value), 1000)
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
        loadSiteStatus(selectedSiteId.value)
    }
}

async function startWork() {
    try {
        await live.startWork()
        selectedSiteId.value = live.organizationId
        mySession.value = null
        loadSiteStatus(live.organizationId)
        toast.success(
            'Mulai kerja',
            canShareScreen
                ? 'Kamera Anda tersiar. Tekan Bagikan layar supaya layar kerja ikut terlihat.'
                : 'Kamera Anda sedang disiarkan ke rekan se-site',
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
        if (selectedSiteId.value) await selectSite(selectedSiteId.value)
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
    statusTimer = setInterval(() => selectedSiteId.value && loadSiteStatus(selectedSiteId.value), 15_000)

    try {
        await loadSites()
        if (canBroadcast.value) await loadMySession()
        if (canBroadcast.value) loadLiveApp().catch(() => {})
    } catch (err) {
        toast.error('Gagal memuat data Live Kerja', err.response?.data?.message)
        return
    }

    // Koneksi tetap hidup saat pindah halaman (disimpan di store) -- jangan
    // sambung ulang kalau memang sudah terhubung.
    if (live.mode !== 'idle') {
        selectedSiteId.value = live.organizationId
        loadSiteStatus(live.organizationId)
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
        <PageHeader
            eyebrow="Pantau"
            title="Live Kerja"
            subtitle="Layar kerja & kamera staf, hanya terlihat oleh rekan di site yang sama. Tanpa suara, tidak direkam."
        >
            <template #actions>
                <template v-if="canBroadcast">
                    <BaseButton v-if="!live.isBroadcasting" :loading="live.connecting" @click="confirmStartOpen = true">
                        <Play class="size-4" />
                        {{ mySession ? 'Lanjutkan siaran' : 'Mulai kerja' }}
                    </BaseButton>
                </template>
            </template>
            <template #readouts>
                <Readout
                    label="Live di site ini"
                    :value="live.mode === 'idle' ? '—' : live.remoteParticipants.length"
                    :led="live.remoteParticipants.length ? 'danger' : 'muted'"
                />
                <Readout v-if="roster.length" label="Staf site" :value="roster.length" />
                <Readout
                    v-if="sites.length > 1"
                    label="Total live"
                    :value="sites.reduce((total, site) => total + (site.live_count ?? 0), 0)"
                />
                <Readout v-if="live.isBroadcasting" label="Siaran Anda" :value="myStatusMeta?.label ?? 'Aktif'" led="danger" />
            </template>
        </PageHeader>

        <div class="space-y-6 p-4 sm:p-8">
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
                class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-base-800 bg-base-900 px-4 py-3 text-sm"
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

            <!-- Pilihan site: hanya muncul kalau user boleh menonton lebih dari satu site -->
            <div v-if="sites.length > 1" class="flex flex-wrap gap-2" role="group" aria-label="Pilih site">
                <button
                    v-for="site in sites"
                    :key="site.id"
                    type="button"
                    :disabled="live.isBroadcasting || live.connecting"
                    :aria-pressed="selectedSiteId === site.id"
                    class="inline-flex items-center gap-2.5 rounded-lg border px-3.5 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent-400 disabled:cursor-not-allowed disabled:opacity-50"
                    :class="
                        selectedSiteId === site.id
                            ? 'border-accent-500/60 bg-base-850 text-base-50'
                            : 'border-base-800 text-base-300 hover:border-base-600'
                    "
                    @click="selectSite(site.id)"
                >
                    {{ site.name }}
                    <span
                        class="flex items-center gap-1.5 font-mono text-[11px] tabular-nums"
                        :class="site.live_count ? 'text-danger-400' : 'text-base-500'"
                    >
                        <span class="led" :class="!site.live_count && 'led-off'" />{{ site.live_count ?? 0 }}
                    </span>
                </button>
            </div>

            <!-- Monitor siaran sendiri: layar + kamera saya, dan kendali kerja -->
            <section
                v-if="live.isBroadcasting"
                aria-label="Siaran Anda"
                class="grid gap-4 rounded-2xl border border-base-800 bg-base-900/60 p-3 sm:p-4 xl:grid-cols-[minmax(0,1fr)_18rem]"
            >
                <LivePairTile
                    class="self-start"
                    :name="auth.user?.name ?? 'Saya'"
                    :screen-track="live.localScreenTrack"
                    :camera-track="live.localCameraTrack"
                    :status="live.myStatus"
                    :swapped="swapped"
                    mirror-camera
                />

                <aside class="flex flex-col gap-5 px-1 pb-1 xl:py-2 xl:pr-2">
                    <div>
                        <p class="eyebrow flex items-center gap-2">
                            <span class="led text-danger-400" />
                            Sedang disiarkan<template v-if="currentSiteName"> · {{ currentSiteName }}</template>
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
                            <dd class="mt-1 font-mono tabular-nums" :class="live.localScreenTrack ? 'text-base-50' : 'text-orange-300'">
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

            <!-- Papan status: semua staf site ini, termasuk yang belum mulai kerja -->
            <section v-if="roster.length" aria-labelledby="live-status-title">
                <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <h2 id="live-status-title" class="eyebrow !text-base-200">Status staf</h2>
                    <span
                        v-for="entry in statusCounts"
                        :key="entry.key"
                        class="flex items-center gap-1.5 font-mono text-[11px] text-base-400 tabular-nums"
                    >
                        <span class="led" :class="entry.led" />{{ entry.label }} {{ entry.count }}
                    </span>
                </div>
                <ul class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                    <li
                        v-for="staff in roster"
                        :key="staff.user_id"
                        class="flex items-center gap-3 rounded-lg border border-base-800 bg-base-900 px-3 py-2"
                    >
                        <span
                            class="led"
                            :class="[workStatus(staff.status).led, staff.status === 'alert' && 'motion-safe:animate-pulse']"
                        />
                        <span class="min-w-0 flex-1 truncate text-sm text-base-100">{{ staff.name }}</span>
                        <span class="shrink-0 font-mono text-[10.5px] tracking-[0.1em] text-base-400 uppercase">
                            {{ workStatus(staff.status).label }}
                        </span>
                    </li>
                </ul>
            </section>

            <section aria-labelledby="live-wall-title">
                <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <h2 id="live-wall-title" class="eyebrow !text-base-200">
                        Rekan yang sedang live
                        <span class="ml-1 text-base-500 tabular-nums">{{ live.remoteParticipants.length }}</span>
                    </h2>
                    <div class="flex flex-wrap items-center gap-2">
                        <div class="flex rounded-lg border border-base-800 p-0.5" role="radiogroup" aria-label="Jumlah staf per tampilan">
                            <button
                                v-for="count in LAYOUTS"
                                :key="count"
                                type="button"
                                role="radio"
                                :aria-checked="layout === count"
                                class="rounded-md px-2.5 py-1 font-mono text-xs transition-colors focus-visible:outline-2 focus-visible:outline-accent-400"
                                :class="layout === count ? 'bg-base-800 text-base-50' : 'text-base-400 hover:text-base-100'"
                                @click="layout = count"
                            >
                                {{ count }} layar
                            </button>
                        </div>
                        <BaseButton variant="outline" size="sm" :aria-pressed="swapped" @click="swapped = !swapped">
                            <ArrowLeftRight class="size-4" />
                            {{ swapped ? 'Kamera ↔ Layar' : 'Layar ↔ Kamera' }}
                        </BaseButton>
                        <BaseButton variant="outline" size="sm" @click="toggleFullscreen">
                            <Maximize class="size-4" />
                            Layar penuh
                        </BaseButton>
                    </div>
                </div>

                <div ref="wallEl" :class="isFullscreen && 'overflow-auto bg-base-950 p-4'">
                    <div v-if="isFullscreen" class="mb-3 flex items-center justify-between gap-3">
                        <p class="eyebrow !text-base-200">
                            Live Kerja<template v-if="currentSiteName"> · {{ currentSiteName }}</template>
                        </p>
                        <BaseButton variant="outline" size="sm" @click="toggleFullscreen">
                            <Minimize class="size-4" />
                            Keluar layar penuh
                        </BaseButton>
                    </div>

                    <div
                        v-if="live.mode === 'idle' || !live.remoteParticipants.length"
                        class="flex items-center gap-4 rounded-xl border border-dashed border-base-800 px-5 py-5"
                    >
                        <span class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-base-850 text-base-400">
                            <Video class="size-5" />
                        </span>
                        <div class="min-w-0">
                            <p class="text-sm font-medium text-base-100">
                                <template v-if="live.mode === 'idle'">
                                    {{ live.connecting ? 'Menghubungkan ke siaran site…' : 'Belum terhubung ke siaran' }}
                                </template>
                                <template v-else>Belum ada rekan yang mulai kerja</template>
                            </p>
                            <p v-if="!live.connecting" class="mt-0.5 text-xs text-pretty text-base-500">
                                {{
                                    live.mode === 'idle'
                                        ? 'Pilih site di atas untuk melihat siapa saja yang sedang bekerja.'
                                        : 'Layar & kamera rekan di site ini muncul di sini begitu mereka menekan Mulai kerja.'
                                }}
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
                            class="rounded-xl text-left transition-shadow hover:ring-2 hover:ring-accent-400/60 focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:outline-none"
                            :aria-label="`Perbesar ${participant.name || participant.identity}`"
                            @click="focusedIdentity = participant.identity"
                        >
                            <LivePairTile
                                :name="participant.name || participant.identity"
                                :screen-track="trackOf(participant, SCREEN_SOURCE)"
                                :camera-track="trackOf(participant, CAMERA_SOURCE)"
                                :status="statusOf(participant)"
                                :since="liveSince(participant)"
                                :quality="participant.connectionQuality"
                                :swapped="swapped"
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
                </div>
            </section>
        </div>

        <DialogRoot :open="!!focused" @update:open="(v) => !v && (focusedIdentity = null)">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm" />
                <DialogContent
                    class="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[min(110rem,calc((100dvh-9rem)*32/9))] -translate-x-1/2 -translate-y-1/2 overflow-auto focus:outline-none"
                >
                    <div class="mb-3 flex items-center justify-between gap-4">
                        <div class="min-w-0">
                            <DialogTitle class="sr-only">{{ focused?.name || focused?.identity }}</DialogTitle>
                            <DialogDescription class="font-mono text-xs text-base-400 tabular-nums">
                                Live sejak {{ focusedSince ? new Date(focusedSince).toLocaleTimeString('id-ID') : '—' }} · kualitas
                                menyesuaikan koneksi otomatis
                            </DialogDescription>
                        </div>
                        <div class="flex items-center gap-2">
                            <BaseButton variant="outline" size="sm" :aria-pressed="swapped" @click="swapped = !swapped">
                                <ArrowLeftRight class="size-4" />
                                Tukar
                            </BaseButton>
                            <BaseButton variant="ghost" size="icon" aria-label="Tutup" @click="focusedIdentity = null">
                                <X class="size-5" />
                            </BaseButton>
                        </div>
                    </div>
                    <!-- Track yang sama terpasang di ubin grid & di sini; adaptiveStream
                         memakai elemen terbesar, jadi tampilan ini meminta layer tertinggi. -->
                    <LivePairTile
                        v-if="focused"
                        :name="focused.name || focused.identity"
                        :screen-track="trackOf(focused, SCREEN_SOURCE)"
                        :camera-track="trackOf(focused, CAMERA_SOURCE)"
                        :status="statusOf(focused)"
                        :since="focusedSince"
                        :quality="focused.connectionQuality"
                        :swapped="swapped"
                        large
                    />
                </DialogContent>
            </DialogPortal>
        </DialogRoot>

        <ConfirmDialog
            v-model:open="confirmStartOpen"
            title="Mulai kerja & nyalakan kamera?"
            description="Kamera Anda menyala dan disiarkan ke semua rekan di site Anda sampai Anda menekan Selesai kerja. Setelah itu Anda bisa membagikan layar kerja. Tidak ada suara yang dikirim dan tidak ada yang direkam. Jam mulai, istirahat, dan selesai kerja tercatat di log kerja."
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
