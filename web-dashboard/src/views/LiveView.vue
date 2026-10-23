<script setup>
import { ChevronLeft, ChevronRight, Play, Square, Video, X } from '@lucide/vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, onMounted, ref, watch } from 'vue'

import LiveVideoTile from '@/components/live/LiveVideoTile.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
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

async function selectSite(siteId) {
    if (live.isBroadcasting) return // siaran terkunci ke site sendiri
    selectedSiteId.value = siteId
    page.value = 0
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
    } catch (err) {
        toast.error('Gagal memuat data Live Kerja', err.response?.data?.message)
        return
    }

    // Koneksi tetap hidup saat pindah halaman (disimpan di store) -- jangan
    // sambung ulang kalau memang sudah terhubung.
    if (live.mode !== 'idle') {
        selectedSiteId.value = live.organizationId
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
                    <BaseButton v-else variant="danger" :loading="live.connecting" @click="confirmEndOpen = true">
                        <Square class="size-4" />
                        Selesai kerja
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

            <section v-if="live.isBroadcasting" class="max-w-sm">
                <p class="eyebrow mb-2">Kamera Anda</p>
                <LiveVideoTile :track="live.localCameraTrack" :label="auth.user?.name ?? 'Saya'" mirrored live />
                <p class="mt-2 text-xs text-base-500">
                    Biarkan aplikasi ini tetap terbuka selama bekerja. Kamera berhenti kalau aplikasi ditutup.
                </p>
            </section>

            <section>
                <div class="mb-3 flex items-center justify-between gap-3">
                    <p class="eyebrow !text-base-200">
                        Rekan yang sedang live
                        <span class="ml-1 text-base-500">{{ live.remoteParticipants.length }}</span>
                    </p>
                    <div v-if="pageCount > 1" class="flex items-center gap-2 text-xs text-base-400">
                        <BaseButton variant="ghost" size="sm" :disabled="page === 0" @click="page--">
                            <ChevronLeft class="size-4" />
                        </BaseButton>
                        {{ page + 1 }} / {{ pageCount }}
                        <BaseButton variant="ghost" size="sm" :disabled="page >= pageCount - 1" @click="page++">
                            <ChevronRight class="size-4" />
                        </BaseButton>
                    </div>
                </div>

                <div v-if="live.mode === 'idle'" class="rounded-xl border border-dashed border-base-800">
                    <EmptyState
                        :icon="Video"
                        :title="live.connecting ? 'Menghubungkan ke siaran site…' : 'Belum terhubung ke siaran'"
                        :description="live.connecting ? null : 'Pilih site di atas untuk melihat siapa saja yang sedang bekerja.'"
                    />
                </div>
                <div v-else-if="!live.remoteParticipants.length" class="rounded-xl border border-dashed border-base-800">
                    <EmptyState
                        :icon="Video"
                        title="Belum ada rekan yang mulai kerja"
                        description="Kamera rekan di site ini muncul di sini begitu mereka menekan Mulai kerja."
                    />
                </div>
                <div v-else class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                    <button
                        v-for="participant in visibleParticipants"
                        :key="participant.identity"
                        type="button"
                        class="text-left"
                        @click="focusedIdentity = participant.identity"
                    >
                        <LiveVideoTile :track="cameraTrackOf(participant)" :label="participant.name || participant.identity" live />
                    </button>
                </div>
            </section>
        </div>

        <DialogRoot :open="!!focused" @update:open="(v) => !v && (focusedIdentity = null)">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm" />
                <DialogContent
                    class="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 focus:outline-none"
                >
                    <div class="mb-2 flex items-center justify-between">
                        <DialogTitle class="text-sm font-semibold text-base-50">{{ focused?.name || focused?.identity }}</DialogTitle>
                        <DialogDescription class="sr-only">Siaran kamera staf dalam ukuran besar</DialogDescription>
                        <button type="button" class="text-base-400 hover:text-base-50" @click="focusedIdentity = null">
                            <X class="size-5" />
                        </button>
                    </div>
                    <!-- Elemen besar -> adaptiveStream otomatis meminta layer resolusi tertinggi -->
                    <LiveVideoTile v-if="focused" :track="cameraTrackOf(focused)" :label="focused.name || focused.identity" live />
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
