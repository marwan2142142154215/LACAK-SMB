<script setup>
import { ChevronDown, Download, Hammer, PackageOpen, Search, Trash2, Upload } from '@lucide/vue'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BasePagination from '@/components/ui/BasePagination.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import SiteFilter from '@/components/ui/SiteFilter.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import StatusDot from '@/components/ui/StatusDot.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

dayjs.extend(relativeTime)

const auth = useAuthStore()
const toast = useToast()

const builds = ref([])
const organizations = ref([])
const loading = ref(true)
const generateDialogOpen = ref(false)
const uploadDialogOpen = ref(false)
const generating = ref(false)
const submitting = ref(false)
const deleteTarget = ref(null)
const deleting = ref(false)
let pollTimer = null

const generateForm = ref({
    organization_id: auth.user?.organization_id ?? null,
    apk_type: 'tracker',
    version: '1.0.0',
    device_name: '',
})

// Zero-touch: APK pelacak terikat SATU device sejak dibuild (identitas +
// device_secret ditanam langsung, lihat ApkBuildsController.generate) --
// dialog build-nya ikut minta nama device.
const uploadForm = ref({
    organization_id: auth.user?.organization_id ?? null,
    version: '',
    apk_file: null,
})

// SMB Live Kerja cukup satu: selama ada yang berhasil / sedang dibuild,
// tidak perlu build lagi (backend juga menolak). Dihitung server dari SEMUA build,
// bukan hanya halaman yang sedang tampil.
const existingLive = ref(null)
const liveBlocked = computed(() => generateForm.value.apk_type === 'live' && !!existingLive.value)

const hasActiveBuild = ref(false)

function typeLabel(build) {
    return TYPE_LABEL[build.apk_type] ?? 'SMB Pelacak'
}

async function confirmDelete() {
    deleting.value = true
    try {
        await api.delete(`/apk-builds/${deleteTarget.value.id}`)
        toast.success('Arsip APK dihapus')
        deleteTarget.value = null
        await loadBuilds()
    } catch (err) {
        toast.error('Gagal menghapus APK build', err.response?.data?.message)
    } finally {
        deleting.value = false
    }
}

// Riwayat dimuat per halaman (10) dengan pencarian & filter status di server.
const PER_PAGE = 10
const SEARCH_DEBOUNCE_MS = 350

const page = ref(1)
const total = ref(0)
const totalAll = ref(0)
const countByStatus = ref({})
const search = ref('')
const statusFilter = ref('')
const siteFilter = ref('')
const typeFilter = ref('')
const refreshing = ref(false)
const lastPage = computed(() => Math.max(Math.ceil(total.value / PER_PAGE), 1))
const hasFilters = computed(() =>
    Boolean(search.value.trim() || statusFilter.value || siteFilter.value || typeFilter.value),
)
let loadSeq = 0
let searchTimer = null

const TYPE_LABEL = { tracker: 'SMB Pelacak', master: 'SMB Admin', live: 'SMB Live Kerja', server: 'Server' }
const TYPE_BADGE = { tracker: 'neutral', master: 'accent', live: 'accent', server: 'neutral' }
// SMB Admin & SMB Live Kerja universal (akses/site mengikuti akun yang login).
const UNIVERSAL_TYPES = ['master', 'live']

// Untuk siapa paket ini: APK master & live universal, sisanya milik satu site
function buildTarget(build) {
    if (UNIVERSAL_TYPES.includes(build.apk_type)) return 'Semua site'
    return build.organization_name ?? build.embedded_site_code
}

function menuItems(build) {
    return [{ label: 'Hapus arsip', icon: Trash2, onSelect: () => (deleteTarget.value = build), danger: true }]
}

async function loadBuilds() {
    // Hanya jawaban permintaan terbaru yang dipakai (ketikan cepat tidak menimpa hasil baru).
    const seq = ++loadSeq
    refreshing.value = true
    try {
        const response = await api.get('/apk-builds', {
            params: {
                per_page: PER_PAGE,
                page: page.value,
                search: search.value.trim() || undefined,
                status: statusFilter.value || undefined,
                organization_id: siteFilter.value || undefined,
                apk_type: typeFilter.value || undefined,
            },
        })
        if (seq !== loadSeq) return
        const data = response.data.data
        // Halaman ini sudah kosong (mis. arsip terakhirnya dihapus): mundur ke halaman terakhir.
        if (data.items.length === 0 && page.value > 1 && data.total > 0) {
            page.value = Math.max(Math.ceil(data.total / PER_PAGE), 1)
            return loadBuilds()
        }
        builds.value = data.items
        total.value = data.total
        totalAll.value = data.total_all ?? data.total
        countByStatus.value = data.counts_by_status ?? {}
        existingLive.value = data.live_build ?? null
        hasActiveBuild.value = Boolean(data.has_active_build)
    } finally {
        if (seq === loadSeq) {
            loading.value = false
            refreshing.value = false
        }
    }
}

function goToPage(next) {
    page.value = next
    loadBuilds()
}

function resetFilters() {
    search.value = ''
    statusFilter.value = ''
    siteFilter.value = ''
    typeFilter.value = ''
}

watch(search, () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
        page.value = 1
        loadBuilds()
    }, SEARCH_DEBOUNCE_MS)
})
watch([statusFilter, siteFilter, typeFilter], () => {
    page.value = 1
    loadBuilds()
})
// Site yang dipilih di penyaring ikut menjadi pilihan awal form build/unggah (tetap terlihat & bisa diganti).
watch(siteFilter, (id) => {
    if (!id) return
    generateForm.value.organization_id = id
    uploadForm.value.organization_id = id
})

// Root memilih dari semua site; admin & leader dari site yang dipegangnya
// (daftar Live Kerja); admin site selalu site-nya sendiri.
const canPickSite = computed(() => auth.isSuperAdmin || ['all', 'granted'].includes(auth.user?.site_scope))

async function loadOrganizations() {
    if (!canPickSite.value) return
    try {
        organizations.value = (await api.get('/organizations/mine')).data.data
    } catch {
        organizations.value = []
    }
    // Site TIDAK dipilihkan otomatis kalau ada lebih dari satu: APK terikat ke site-nya, jadi pemilihnya
    // harus sengaja memilih. Hanya bila cuma ada satu site, itu yang dipakai.
    const only = organizations.value.length === 1 ? organizations.value[0].id : null
    if (!generateForm.value.organization_id) generateForm.value.organization_id = only
    if (!uploadForm.value.organization_id) uploadForm.value.organization_id = only
}

function handleFileChange(event) {
    uploadForm.value.apk_file = event.target.files[0] ?? null
}

async function submitGenerate() {
    generating.value = true
    try {
        await api.post('/apk-builds/generate', generateForm.value)
        toast.success('Build dimulai', 'Biasanya selesai dalam 1-2 menit, status diperbarui otomatis')
        generateDialogOpen.value = false
        generateForm.value.device_name = ''
        await loadBuilds()
        schedulePoll()
    } catch (err) {
        toast.error('Gagal memulai build', err.response?.data?.message)
    } finally {
        generating.value = false
    }
}

async function submitUpload() {
    submitting.value = true
    try {
        const payload = new FormData()
        payload.append('organization_id', uploadForm.value.organization_id)
        payload.append('version', uploadForm.value.version)
        payload.append('apk_file', uploadForm.value.apk_file)

        await api.post('/apk-builds', payload, {
            headers: { 'Content-Type': 'multipart/form-data' },
        })
        toast.success('APK berhasil diunggah')
        uploadDialogOpen.value = false
        await loadBuilds()
    } catch (err) {
        toast.error('Gagal mengunggah APK', err.response?.data?.message)
    } finally {
        submitting.value = false
    }
}

function schedulePoll() {
    if (pollTimer) return
    pollTimer = setInterval(async () => {
        await loadBuilds()
        if (!hasActiveBuild.value) {
            clearInterval(pollTimer)
            pollTimer = null
        }
    }, 4000)
}

onMounted(async () => {
    loading.value = true
    await Promise.all([loadBuilds(), loadOrganizations()])
    if (hasActiveBuild.value) schedulePoll()
})

onBeforeUnmount(() => {
    if (pollTimer) clearInterval(pollTimer)
    clearTimeout(searchTimer)
})
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Perangkat"
            title="Build APK"
            subtitle="SMB Pelacak terikat ke satu device sejak dibuat, SMB Admin & SMB Live Kerja berlaku untuk semua site, dan server untuk komputer kantor."
        >
            <template #actions>
                <BaseButton variant="outline" @click="uploadDialogOpen = true"><Upload class="size-4" /> Unggah manual</BaseButton>
                <BaseButton @click="generateDialogOpen = true"><Hammer class="size-4" /> Buat build</BaseButton>
            </template>
            <template v-if="!loading" #readouts>
                <Readout label="Build" :value="totalAll" />
                <Readout label="Berhasil" :value="countByStatus.success ?? 0" led="accent" />
                <Readout
                    label="Sedang build"
                    :value="(countByStatus.building ?? 0) + (countByStatus.pending ?? 0)"
                    :led="hasActiveBuild ? 'warning' : 'muted'"
                />
                <Readout label="Gagal" :value="countByStatus.failed ?? 0" :led="countByStatus.failed ? 'danger' : 'muted'" />
            </template>
        </PageHeader>

        <div class="p-4 sm:p-8">
            <BaseCard title="Riwayat build" :count="loading ? null : total" flush>
                <div class="flex flex-wrap items-center gap-2 border-b border-base-800 px-5 py-3">
                    <label class="relative min-w-52 flex-1">
                        <span class="sr-only">Cari build</span>
                        <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                        <input
                            v-model="search"
                            type="search"
                            maxlength="100"
                            placeholder="Cari site, versi, atau kode site…"
                            class="field-control h-9 pl-9 text-sm"
                        />
                    </label>
                    <BaseSelect v-model="statusFilter" variant="compact" aria-label="Filter status">
                            <option value="">Semua status</option>
                            <option value="success">Berhasil</option>
                            <option value="building">Sedang build</option>
                            <option value="pending">Menunggu</option>
                            <option value="failed">Gagal</option>
                        </BaseSelect>
                    <SiteFilter v-if="organizations.length > 1" v-model="siteFilter" :sites="organizations" />
                    <BaseSelect v-model="typeFilter" variant="compact" aria-label="Filter aplikasi">
                            <option value="">Semua aplikasi</option>
                            <option value="tracker">SMB Pelacak</option>
                            <option value="master">SMB Admin</option>
                            <option value="live">SMB Live Kerja</option>
                            <option value="server">Server</option>
                        </BaseSelect>
                </div>

                <div v-if="loading" class="px-5 py-12 text-center text-sm text-base-500">Memuat build…</div>
                <EmptyState
                    v-else-if="builds.length === 0 && hasFilters"
                    :icon="Search"
                    title="Tidak ada build yang cocok"
                    description="Coba kata kunci lain atau hapus filter."
                >
                    <BaseButton variant="outline" @click="resetFilters">Hapus filter</BaseButton>
                </EmptyState>
                <EmptyState
                    v-else-if="builds.length === 0"
                    :icon="PackageOpen"
                    title="Belum ada APK"
                    description="Buat SMB Pelacak untuk satu device, atau SMB Admin untuk tim. Server menyusunnya dalam 1–2 menit."
                >
                    <BaseButton @click="generateDialogOpen = true"><Hammer class="size-4" /> Buat build</BaseButton>
                </EmptyState>
                <div v-else class="overflow-x-auto transition-opacity" :class="refreshing && 'opacity-60'">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Paket</th>
                                <th class="hidden sm:table-cell">Untuk</th>
                                <th>Status</th>
                                <th class="hidden lg:table-cell">Checksum</th>
                                <th class="hidden md:table-cell">Dibuat</th>
                                <th class="w-0"><span class="sr-only">Aksi</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="build in builds" :key="build.id">
                                <td>
                                    <div class="flex items-center gap-2.5">
                                        <BaseBadge :variant="TYPE_BADGE[build.apk_type]">{{ typeLabel(build) }}</BaseBadge>
                                        <span class="font-mono text-sm text-base-50">v{{ build.version }}</span>
                                    </div>
                                </td>
                                <td class="hidden text-base-300 sm:table-cell">{{ buildTarget(build) }}</td>
                                <td class="max-w-xs">
                                    <StatusDot :status="build.status" :class="build.status === 'building' && 'animate-pulse'" />
                                    <p
                                        v-if="build.status === 'failed' && build.build_log"
                                        class="mt-1 truncate font-mono text-[11px] text-danger-400/90"
                                        :title="build.build_log"
                                    >
                                        {{ build.build_log }}
                                    </p>
                                </td>
                                <td class="hidden font-mono text-xs text-base-500 lg:table-cell" :title="build.checksum_sha256">
                                    {{ build.checksum_sha256 ? `${build.checksum_sha256.slice(0, 12)}…` : '—' }}
                                </td>
                                <td
                                    class="hidden text-xs text-base-400 md:table-cell"
                                    :title="dayjs(build.created_at).format('DD MMM YYYY HH:mm')"
                                >
                                    {{ dayjs(build.created_at).fromNow() }}
                                </td>
                                <td>
                                    <div class="flex items-center justify-end gap-1">
                                        <a
                                            v-if="build.download_url"
                                            :href="build.download_url"
                                            class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-base-700 px-3 text-xs font-medium whitespace-nowrap text-base-100 transition-colors hover:border-base-500 hover:bg-base-850 focus-visible:outline-2 focus-visible:outline-accent-400"
                                        >
                                            <Download class="size-3.5" /> <span class="max-sm:sr-only">Unduh</span>
                                        </a>
                                        <RowMenu :items="menuItems(build)" :label="`Aksi untuk ${typeLabel(build)} v${build.version}`" />
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <BasePagination
                    v-if="!loading"
                    :page="page"
                    :last-page="lastPage"
                    :total="total"
                    :per-page="PER_PAGE"
                    :disabled="refreshing"
                    @update:page="goToPage"
                />
            </BaseCard>
        </div>

        <BaseDialog
            :open="generateDialogOpen"
            title="Buat build APK"
            description="Server menyusun APK dengan identitas yang sudah ditanam. Status di daftar diperbarui otomatis."
            @update:open="(v) => (generateDialogOpen = v)"
        >
            <form id="generate-form" class="space-y-4" @submit.prevent="submitGenerate">
                <BaseSelect v-model="generateForm.apk_type" label="Jenis paket">
                    <option value="tracker">SMB Pelacak — pelacak lokasi & kunci untuk satu device di satu site</option>
                    <option value="master">SMB Admin — untuk tim admin/leader, akses mengikuti akun</option>
                    <option value="live">SMB Live Kerja — siaran Live Kerja dari HP staf</option>
                    <option value="server">Server — lacak-server.exe untuk komputer kantor</option>
                </BaseSelect>
                <BaseSelect
                    v-if="canPickSite"
                    v-model="generateForm.organization_id"
                    :label="UNIVERSAL_TYPES.includes(generateForm.apk_type) ? 'Site tempat arsip' : 'Site tujuan APK'"
                    :hint="
                        UNIVERSAL_TYPES.includes(generateForm.apk_type)
                            ? 'Aplikasi ini berlaku untuk semua site; site ini hanya tempat arsip dan unduhannya (terlihat oleh yang punya akses site ini).'
                            : 'APK terikat ke site ini dan tidak bisa dipindah. Pastikan sudah benar.'
                    "
                    required
                >
                    <option :value="null" disabled>Pilih site</option>
                    <option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option>
                </BaseSelect>
                <BaseInput v-model="generateForm.version" label="Versi" placeholder="1.0.0" required />
                <template v-if="generateForm.apk_type === 'tracker'">
                    <BaseInput
                        v-model="generateForm.device_name"
                        label="Nama device"
                        placeholder="Contoh: HP CS Line — Asep"
                        hint="Device otomatis muncul di menu Device setelah APK dipasang."
                        required
                    />
                </template>
                <p
                    v-else-if="generateForm.apk_type === 'master'"
                    class="rounded-lg border border-base-700 bg-base-850 p-3 text-xs text-pretty text-base-300"
                >
                    Satu SMB Admin untuk semua site. Site yang terlihat ditentukan oleh akun yang masuk, bukan oleh APK-nya.
                </p>
                <p
                    v-else-if="liveBlocked"
                    class="rounded-lg border border-warning-500/40 bg-warning-500/10 p-3 text-xs text-pretty text-warning-400"
                    role="status"
                >
                    SMB Live Kerja v{{ existingLive.version }}
                    {{ existingLive.status === 'success' ? 'sudah ada — cukup unduh dari daftar.' : 'sedang dibuild.' }}
                    Untuk build versi baru, hapus arsip SMB Live Kerja yang lama dulu.
                </p>
                <p
                    v-else-if="generateForm.apk_type === 'live'"
                    class="rounded-lg border border-base-700 bg-base-850 p-3 text-xs text-pretty text-base-300"
                >
                    Satu SMB Live Kerja untuk semua site: siaran kamera tetap jalan saat staf pindah aplikasi atau layar mati. Build terbaru
                    otomatis muncul sebagai tombol unduh di halaman Live Kerja.
                </p>
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="generateDialogOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="generate-form" :loading="generating" :disabled="liveBlocked"
                    ><Hammer class="size-4" /> Mulai build</BaseButton
                >
            </template>
        </BaseDialog>

        <BaseDialog
            :open="uploadDialogOpen"
            title="Unggah APK manual"
            description="Untuk APK yang di-build di luar sistem ini. Checksum dihitung oleh server."
            @update:open="(v) => (uploadDialogOpen = v)"
        >
            <form id="upload-form" class="space-y-4" @submit.prevent="submitUpload">
                <BaseSelect
                    v-if="canPickSite"
                    v-model="uploadForm.organization_id"
                    label="Site tujuan APK"
                    hint="APK terikat ke site ini. Pastikan sudah benar."
                    required
                >
                    <option :value="null" disabled>Pilih site</option>
                    <option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option>
                </BaseSelect>
                <BaseInput v-model="uploadForm.version" label="Versi" placeholder="1.0.0" required />
                <label class="block">
                    <span class="field-label">Berkas APK <span class="text-danger-400" aria-hidden="true">*</span></span>
                    <input type="file" accept=".apk" class="file-control" required @change="handleFileChange" />
                </label>
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="uploadDialogOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="upload-form" :loading="submitting"><Upload class="size-4" /> Unggah</BaseButton>
            </template>
        </BaseDialog>

        <ConfirmDialog
            :open="!!deleteTarget"
            :title="deleteTarget ? `Hapus ${typeLabel(deleteTarget)} v${deleteTarget.version}?` : ''"
            description="Berkas APK di server ikut dihapus. Device yang sudah memasangnya tidak terpengaruh."
            confirm-label="Hapus arsip"
            :loading="deleting"
            @update:open="(v) => !v && (deleteTarget = null)"
            @confirm="confirmDelete"
        />
    </div>
</template>
