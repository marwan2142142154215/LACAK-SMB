<script setup>
import { Download, Hammer, PackageOpen, Trash2, Upload } from '@lucide/vue'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
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
    consent_document_id: null,
})

// Zero-touch: APK pelacak sekarang terikat SATU device sejak dibuild
// (identitas+device_secret-nya ditanam langsung, lihat backend-api
// ApkBuildController::generate) -- dialog build-nya ikut minta nama
// device & dokumen consent, bukan cuma site+versi seperti sebelumnya.
const consentDocuments = ref([])

async function loadConsentDocuments() {
    if (generateForm.value.apk_type !== 'tracker' || !generateForm.value.organization_id) {
        consentDocuments.value = []
        return
    }
    try {
        const response = await api.get('/consent-documents', {
            params: { organization_id: generateForm.value.organization_id, per_page: 100 },
        })
        consentDocuments.value = response.data.data.items.filter((d) => d.is_active)
        if (!consentDocuments.value.some((d) => d.id === generateForm.value.consent_document_id)) {
            generateForm.value.consent_document_id = consentDocuments.value[0]?.id ?? null
        }
    } catch {
        consentDocuments.value = []
    }
}

const uploadForm = ref({
    organization_id: auth.user?.organization_id ?? null,
    version: '',
    apk_file: null,
})

const hasActiveBuild = computed(() => builds.value.some((b) => b.status === 'pending' || b.status === 'building'))

function typeLabel(build) {
    return TYPE_LABEL[build.apk_type] ?? 'APK Pelacak'
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

const countByStatus = computed(() =>
    builds.value.reduce((counts, build) => ({ ...counts, [build.status]: (counts[build.status] ?? 0) + 1 }), {}),
)

const TYPE_LABEL = { tracker: 'APK Pelacak', master: 'APK Master', live: 'APK Live', server: 'Server' }
const TYPE_BADGE = { tracker: 'neutral', master: 'accent', live: 'accent', server: 'neutral' }
// APK Master & Live universal (akses/site mengikuti akun yang login).
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
    try {
        const response = await api.get('/apk-builds', { params: { per_page: 100 } })
        builds.value = response.data.data.items
    } finally {
        loading.value = false
    }
}

async function loadOrganizations() {
    if (!auth.isSuperAdmin) return
    const response = await api.get('/organizations')
    organizations.value = response.data.data.items
    const fallback = organizations.value[0]?.id ?? null
    if (!generateForm.value.organization_id) generateForm.value.organization_id = fallback
    if (!uploadForm.value.organization_id) uploadForm.value.organization_id = fallback
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

watch([() => generateForm.value.apk_type, () => generateForm.value.organization_id, generateDialogOpen], () => {
    if (generateDialogOpen.value) loadConsentDocuments()
})

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
})
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Perangkat"
            title="Build APK"
            subtitle="APK pelacak terikat ke satu device sejak dibuat, APK Master & APK Live berlaku untuk semua site, dan server untuk komputer kantor."
        >
            <template #actions>
                <BaseButton variant="outline" @click="uploadDialogOpen = true"><Upload class="size-4" /> Unggah manual</BaseButton>
                <BaseButton @click="generateDialogOpen = true"><Hammer class="size-4" /> Buat build</BaseButton>
            </template>
            <template v-if="!loading" #readouts>
                <Readout label="Build" :value="builds.length" />
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
            <BaseCard title="Riwayat build" :count="loading ? null : builds.length" flush>
                <div v-if="loading" class="px-5 py-12 text-center text-sm text-base-500">Memuat build…</div>
                <EmptyState
                    v-else-if="builds.length === 0"
                    :icon="PackageOpen"
                    title="Belum ada APK"
                    description="Buat APK pelacak untuk satu device, atau APK Master untuk tim. Server menyusunnya dalam 1–2 menit."
                >
                    <BaseButton @click="generateDialogOpen = true"><Hammer class="size-4" /> Buat build</BaseButton>
                </EmptyState>
                <div v-else class="overflow-x-auto">
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
                    <option value="tracker">APK pelacak — untuk satu device di satu site</option>
                    <option value="master">APK Master — untuk tim, akses mengikuti akun</option>
                    <option value="live">APK Live — siaran Live Kerja dari HP staf</option>
                    <option value="server">Server — lacak-server.exe untuk komputer kantor</option>
                </BaseSelect>
                <BaseSelect
                    v-if="auth.isSuperAdmin && !UNIVERSAL_TYPES.includes(generateForm.apk_type)"
                    v-model="generateForm.organization_id"
                    label="Site"
                    required
                >
                    <option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option>
                </BaseSelect>
                <BaseInput v-model="generateForm.version" label="Versi" placeholder="1.0.0" required />
                <template v-if="generateForm.apk_type === 'tracker'">
                    <BaseInput v-model="generateForm.device_name" label="Nama device" placeholder="Contoh: HP CS Line — Asep" required />
                    <BaseSelect
                        v-model="generateForm.consent_document_id"
                        label="Dokumen consent"
                        required
                        hint="Hanya consent yang masih berlaku di site ini. Device otomatis muncul di menu Device setelah APK dipasang."
                    >
                        <option v-if="consentDocuments.length === 0" :value="null" disabled>
                            Belum ada consent yang berlaku di site ini
                        </option>
                        <option v-for="doc in consentDocuments" :key="doc.id" :value="doc.id">{{ doc.subject_name }}</option>
                    </BaseSelect>
                </template>
                <p
                    v-else-if="generateForm.apk_type === 'master'"
                    class="rounded-lg border border-base-700 bg-base-850 p-3 text-xs text-pretty text-base-300"
                >
                    Satu APK Master untuk semua site. Site yang terlihat ditentukan oleh akun yang masuk, bukan oleh APK-nya.
                </p>
                <p
                    v-else-if="generateForm.apk_type === 'live'"
                    class="rounded-lg border border-base-700 bg-base-850 p-3 text-xs text-pretty text-base-300"
                >
                    Satu APK Live untuk semua site: siaran kamera tetap jalan saat staf pindah aplikasi atau layar mati. Build terbaru
                    otomatis muncul sebagai tombol unduh di halaman Live Kerja.
                </p>
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="generateDialogOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="generate-form" :loading="generating"><Hammer class="size-4" /> Mulai build</BaseButton>
            </template>
        </BaseDialog>

        <BaseDialog
            :open="uploadDialogOpen"
            title="Unggah APK manual"
            description="Untuk APK yang di-build di luar sistem ini. Checksum dihitung oleh server."
            @update:open="(v) => (uploadDialogOpen = v)"
        >
            <form id="upload-form" class="space-y-4" @submit.prevent="submitUpload">
                <BaseSelect v-if="auth.isSuperAdmin" v-model="uploadForm.organization_id" label="Site" required>
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
