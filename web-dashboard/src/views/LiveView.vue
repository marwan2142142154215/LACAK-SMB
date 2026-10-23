<script setup>
import { ChevronLeft, ChevronRight, Play, Square, Video, X } from '@lucide/vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'

import LiveVideoTile from '@/components/live/LiveVideoTile.vue'
import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
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
// shallowRef: objek peserta LiveKit jangan dibungkus proxy reaktif dalam.
const focused = shallowRef(null)
const confirmStartOpen = ref(false)
const confirmEndOpen = ref(false)

const canBroadcast = computed(() => auth.hasPermission('live.broadcast') && !!auth.user?.organization_id)

const pageCount = computed(() => Math.max(1, Math.ceil(live.remoteParticipants.length / PAGE_SIZE)))
const visibleParticipants = computed(() => live.remoteParticipants.slice(page.value * PAGE_SIZE, (page.value + 1) * PAGE_SIZE))

function cameraTrackOf(participant) {
    return participant.getTrackPublication(CAMERA_SOURCE)?.track ?? null
}

watch(
    visibleParticipants,
    (participants) => live.setVisibleParticipants(participants.map((p) => p.identity)),
    { immediate: true },
)

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

async function startWork() {
    try {
        await live.startWork()
        selectedSiteId.value = live.organizationId
        mySession.value = null
        toast.success('Mulai kerja', 'Kamera Anda sedang disiarkan ke rekan se-site')
    } catch (err) {
        const cameraDenied = err.name === 'NotAllowedError' || err.name === 'NotFoundError'
        toast.error('Gagal memulai siaran', cameraDenied ? 'Izin kamera ditolak atau kamera tidak ditemukan' : (err.response?.data?.message ?? err.message))
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
        <PageHeader title="Live Kerja" subtitle="Siaran kamera staf yang sedang bekerja, hanya untuk rekan di site yang sama">
            <template #actions>
                <template v-if="canBroadcast">
                    <BaseButton v-if="!live.isBroadcasting" :loading="live.connecting" @click="confirmStartOpen = true">
                        <Play class="size-4" />
                        {{ mySession ? 'Lanjutkan Siaran' : 'Mulai Kerja' }}
                    </BaseButton>
                    <BaseButton v-else variant="danger" :loading="live.connecting" @click="confirmEndOpen = true">
                        <Square class="size-4" />
                        Selesai Kerja
                    </BaseButton>
                </template>
            </template>
        </PageHeader>

        <div class="space-y-6 p-4 sm:p-8">
            <div
                v-if="mySession && !live.isBroadcasting"
                class="rounded-xl border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-warning-400"
            >
                Sesi kerja Anda masih tercatat aktif sejak {{ new Date(mySession.started_at).toLocaleTimeString('id-ID') }}, tapi kamera tidak sedang
                menyiarkan. Tekan <strong>Lanjutkan Siaran</strong>, atau sesi ditutup otomatis dalam beberapa menit.
            </div>

            <!-- Pilihan site: hanya muncul kalau user boleh menonton lebih dari satu site -->
            <div v-if="sites.length > 1" class="flex flex-wrap gap-2">
                <button
                    v-for="site in sites"
                    :key="site.id"
                    type="button"
                    :disabled="live.isBroadcasting || live.connecting"
                    class="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    :class="
                        selectedSiteId === site.id
                            ? 'border-accent-500/60 bg-accent-500/10 text-accent-300'
                            : 'border-base-700 text-base-300 hover:border-base-500'
                    "
                    @click="selectSite(site.id)"
                >
                    {{ site.name }}
                    <BaseBadge v-if="site.live_count" variant="danger">{{ site.live_count }} live</BaseBadge>
                </button>
            </div>

            <section v-if="live.isBroadcasting" class="max-w-sm">
                <p class="mb-2 text-xs font-semibold tracking-wide text-base-400 uppercase">Kamera Anda</p>
                <LiveVideoTile :track="live.localCameraTrack" :label="auth.user?.name ?? 'Saya'" mirrored live />
                <p class="mt-2 text-xs text-base-500">Biarkan aplikasi ini tetap terbuka selama bekerja -- kamera berhenti kalau aplikasi ditutup.</p>
            </section>

            <section>
                <div class="mb-3 flex items-center justify-between gap-3">
                    <p class="text-xs font-semibold tracking-wide text-base-400 uppercase">
                        Rekan yang sedang live
                        <span class="ml-1 text-base-500">({{ live.remoteParticipants.length }})</span>
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

                <div
                    v-if="live.mode === 'idle'"
                    class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-base-800 py-16 text-sm text-base-500"
                >
                    <Video class="size-6" />
                    {{ live.connecting ? 'Menghubungkan…' : 'Belum terhubung ke siaran site mana pun' }}
                </div>
                <div
                    v-else-if="!live.remoteParticipants.length"
                    class="rounded-xl border border-dashed border-base-800 py-16 text-center text-sm text-base-500"
                >
                    Belum ada rekan yang mulai kerja di site ini
                </div>
                <div v-else class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                    <button v-for="participant in visibleParticipants" :key="participant.identity" type="button" class="text-left" @click="focused = participant">
                        <LiveVideoTile :track="cameraTrackOf(participant)" :label="participant.name || participant.identity" live />
                    </button>
                </div>
            </section>
        </div>

        <DialogRoot :open="!!focused" @update:open="(v) => !v && (focused = null)">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm" />
                <DialogContent class="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 focus:outline-none">
                    <div class="mb-2 flex items-center justify-between">
                        <DialogTitle class="text-sm font-semibold text-base-50">{{ focused?.name || focused?.identity }}</DialogTitle>
                        <DialogDescription class="sr-only">Siaran kamera staf dalam ukuran besar</DialogDescription>
                        <button type="button" class="text-base-400 hover:text-base-50" @click="focused = null">
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
            confirm-label="Mulai Kerja"
            confirm-variant="primary"
            :loading="live.connecting"
            @confirm="startWork"
        />

        <ConfirmDialog
            v-model:open="confirmEndOpen"
            title="Selesai kerja?"
            description="Siaran kamera Anda akan dihentikan."
            confirm-label="Selesai Kerja"
            :loading="live.connecting"
            @confirm="endWork"
        />
    </div>
</template>
