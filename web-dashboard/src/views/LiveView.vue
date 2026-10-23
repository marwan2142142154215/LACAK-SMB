<script setup>
import { ChevronLeft, ChevronRight, Download, Maximize2, Play, RefreshCw, Smartphone, Square, Video, X } from '@lucide/vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, onMounted, ref, watch } from 'vue'

import LiveVideoTile from '@/components/live/LiveVideoTile.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
import { formatElapsed, useNow } from '@/composables/useNow'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { CAMERA_SOURCE, useLiveStore } from '@/stores/live'

// Grid dibatasi per halaman: hanya peserta di halaman yang tampil yang
// di-subscribe (lihat live.setVisibleParticipants), jadi menonton site
// dengan 100+ staf tidak berarti mengunduh 100+ video sekaligus.
const PAGE_SIZE = 12

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

const pageCount = computed(() => Math.max(1, Math.ceil(live.remoteParticipants.length / PAGE_SIZE)))
const visibleParticipants = computed(() => live.remoteParticipants.slice(page.value * PAGE_SIZE, (page.value + 1) * PAGE_SIZE))

function cameraTrackOf(participant) {
    return participant.getTrackPublication(CAMERA_SOURCE)?.track ?? null
}

// Kapan tiap rekan mulai kerja (dari sesi kerja di server). Kalau belum
// termuat, pakai waktu bergabung ke room LiveKit sebagai perkiraan.
const sessionStartByIdentity = ref({})

function liveSince(participant) {
    return sessionStartByIdentity.value[participant.identity] ?? participant.joinedAt ?? null
}

async function loadSiteSessions(siteId) {
    try {
        const response = await api.get('/live/sessions', { params: { organization_id: siteId } })
        sessionStartByIdentity.value = Object.fromEntries(
            response.data.data.items.map((session) => [session.participant_identity, session.started_at]),
        )
    } catch {
        // Hanya untuk durasi -- tanpa data ini ubin tetap tampil.
    }
}

watch(
    () => live.remoteParticipants.map((p) => p.identity),
    (identities) => {
        if (selectedSiteId.value && identities.some((id) => !(id in sessionStartByIdentity.value))) {
            loadSiteSessions(selectedSiteId.value)
        }
    },
)

const focusedSince = computed(() => (focused.value ? liveSince(focused.value) : null))
const currentSiteName = computed(() => sites.value.find((site) => site.id === live.organizationId)?.name ?? null)
const broadcastElapsed = computed(() => formatElapsed(live.broadcastStartedAt, now.value))
// Dibaca ulang tiap detik (ikut `now`) -- kamera HP bisa menurunkan resolusi
// sendiri saat panas atau cahaya kurang.
const cameraSettings = computed(() => {
    now.value
    live.localCameraTrack
    return live.isBroadcasting ? live.localCameraSettings() : null
})

watch(visibleParticipants, (participants) => live.setVisibleParticipants(participants.map((p) => p.identity)), { immediate: true })

watch(pageCount, (count) => {
    if (page.value >= count) page.value = count - 1
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
    sessionStartByIdentity.value = {}
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

async function startWork() {
    try {
        await live.startWork()
        selectedSiteId.value = live.organizationId
        mySession.value = null
        toast.success('Mulai kerja', 'Kamera Anda sedang disiarkan ke rekan se-site')
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
        toast.success('Selesai kerja', 'Siaran kamera dihentikan')
        if (selectedSiteId.value) await selectSite(selectedSiteId.value)
    } catch (err) {
        toast.error('Gagal menghentikan siaran', err.response?.data?.message)
    } finally {
        confirmEndOpen.value = false
    }
}

onMounted(async () => {
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
        loadSiteSessions(live.organizationId)
        return
    }

    const defaultSite = sites.value.find((s) => s.id === auth.user?.organization_id) ?? sites.value[0]
    if (defaultSite) await selectSite(defaultSite.id)
})
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Pantau"
            title="Live Kerja"
            subtitle="Kamera staf yang sedang bekerja, hanya terlihat oleh rekan di site yang sama. Tanpa suara, tidak direkam."
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
                <Readout
                    v-if="sites.length > 1"
                    label="Total live"
                    :value="sites.reduce((total, site) => total + (site.live_count ?? 0), 0)"
                />
                <Readout v-if="live.isBroadcasting" label="Siaran Anda" value="Aktif" led="danger" />
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
                v-if="canBroadcast && liveApp"
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

            <!-- Monitor siaran sendiri: gambar besar + instrumen kamera -->
            <section
                v-if="live.isBroadcasting"
                aria-label="Siaran Anda"
                class="grid gap-4 rounded-2xl border border-base-800 bg-base-900/60 p-3 sm:p-4 lg:grid-cols-[minmax(0,1fr)_18rem]"
            >
                <LiveVideoTile
                    :track="live.localCameraTrack"
                    :label="auth.user?.name ?? 'Saya'"
                    :since="live.broadcastStartedAt"
                    fit="contain"
                    mirrored
                    live
                    framed
                />

                <aside class="flex flex-col gap-5 px-1 pb-1 lg:py-2 lg:pr-2">
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
                            <dt class="eyebrow">Gambar</dt>
                            <dd class="mt-1 font-mono text-base-50 tabular-nums">
                                {{ cameraSettings ? `${cameraSettings.width}×${cameraSettings.height}` : '—' }}
                            </dd>
                        </div>
                        <div class="bg-base-900 px-3 py-2.5">
                            <dt class="eyebrow">Frame</dt>
                            <dd class="mt-1 font-mono text-base-50 tabular-nums">
                                {{ cameraSettings?.frameRate ? `${cameraSettings.frameRate} fps` : '—' }}
                            </dd>
                        </div>
                        <div class="col-span-2 bg-base-900 px-3 py-2.5">
                            <dt class="eyebrow">Kamera</dt>
                            <dd class="mt-1 flex items-center gap-2" :class="live.cameraProblem ? 'text-danger-400' : 'text-accent-300'">
                                <span class="led" />
                                {{ live.cameraProblem ? 'Tidak mengirim gambar' : 'Mengirim gambar' }}
                            </dd>
                        </div>
                    </dl>

                    <p class="text-xs text-pretty text-base-500">
                        Biarkan halaman ini tetap terbuka selama bekerja. Rekan hanya melihat gambar, tanpa suara, dan tidak ada yang
                        direkam.
                    </p>

                    <div class="mt-auto flex flex-wrap gap-2">
                        <BaseButton variant="outline" size="sm" :loading="restartingCamera" @click="restartCamera">
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

            <section aria-labelledby="live-wall-title">
                <div class="mb-3 flex items-center justify-between gap-3">
                    <h2 id="live-wall-title" class="eyebrow !text-base-200">
                        Rekan yang sedang live
                        <span class="ml-1 text-base-500 tabular-nums">{{ live.remoteParticipants.length }}</span>
                    </h2>
                    <div v-if="pageCount > 1" class="flex items-center gap-1 font-mono text-xs text-base-400 tabular-nums">
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
                                    : 'Kamera rekan di site ini muncul di sini begitu mereka menekan Mulai kerja.'
                            }}
                        </p>
                    </div>
                </div>

                <!-- Ubin dibuat lebar (maks 3 kolom): adaptiveStream memilih layer
                     resolusi dari ukuran ubin, jadi ubin besar = gambar lebih tajam. -->
                <div v-else class="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                    <button
                        v-for="participant in visibleParticipants"
                        :key="participant.identity"
                        type="button"
                        class="group relative rounded-xl text-left transition-shadow hover:ring-2 hover:ring-accent-400/60 focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:outline-none"
                        :aria-label="`Perbesar kamera ${participant.name || participant.identity}`"
                        @click="focusedIdentity = participant.identity"
                    >
                        <LiveVideoTile
                            :track="cameraTrackOf(participant)"
                            :label="participant.name || participant.identity"
                            :since="liveSince(participant)"
                            live
                        />
                        <span
                            class="pointer-events-none absolute top-2.5 left-2.5 flex items-center gap-1 rounded bg-black/65 px-1.5 py-1 text-[11px] text-base-100 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                        >
                            <Maximize2 class="size-3" />
                            Perbesar
                        </span>
                    </button>
                </div>
            </section>
        </div>

        <DialogRoot :open="!!focused" @update:open="(v) => !v && (focusedIdentity = null)">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm" />
                <DialogContent
                    class="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-[min(80rem,calc((100dvh-7rem)*16/9))] -translate-x-1/2 -translate-y-1/2 focus:outline-none"
                >
                    <div class="mb-3 flex items-center justify-between gap-4">
                        <div class="min-w-0">
                            <DialogTitle class="truncate font-display text-lg font-semibold text-base-50">
                                {{ focused?.name || focused?.identity }}
                            </DialogTitle>
                            <DialogDescription class="font-mono text-xs text-base-400 tabular-nums">
                                Live sejak {{ focusedSince ? new Date(focusedSince).toLocaleTimeString('id-ID') : '—' }}
                            </DialogDescription>
                        </div>
                        <BaseButton variant="ghost" size="icon" aria-label="Tutup" @click="focusedIdentity = null">
                            <X class="size-5" />
                        </BaseButton>
                    </div>
                    <!-- Track yang sama terpasang di ubin grid & di sini; adaptiveStream
                         memakai elemen terbesar, jadi tampilan ini meminta layer 720p. -->
                    <LiveVideoTile
                        v-if="focused"
                        :track="cameraTrackOf(focused)"
                        :label="focused.name || focused.identity"
                        :since="focusedSince"
                        fit="contain"
                        live
                        framed
                    />
                </DialogContent>
            </DialogPortal>
        </DialogRoot>

        <ConfirmDialog
            v-model:open="confirmStartOpen"
            title="Mulai kerja & nyalakan kamera?"
            description="Kamera Anda akan menyala dan disiarkan langsung ke semua rekan di site Anda sampai Anda menekan Selesai Kerja. Tidak ada suara yang dikirim dan video tidak direkam."
            confirm-label="Mulai kerja"
            confirm-variant="primary"
            :loading="live.connecting"
            @confirm="startWork"
        />

        <ConfirmDialog
            v-model:open="confirmEndOpen"
            title="Selesai kerja?"
            description="Siaran kamera Anda akan dihentikan."
            confirm-label="Selesai kerja"
            :loading="live.connecting"
            @confirm="endWork"
        />
    </div>
</template>
