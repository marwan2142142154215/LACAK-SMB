<script setup>
import { Download, Hammer, Loader2, PackageOpen, Upload } from '@lucide/vue'
import dayjs from 'dayjs'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const toast = useToast()

const builds = ref([])
const organizations = ref([])
const loading = ref(true)
const generateDialogOpen = ref(false)
const uploadDialogOpen = ref(false)
const generating = ref(false)
const submitting = ref(false)
let pollTimer = null

const generateForm = ref({
    organization_id: auth.user?.organization_id ?? null,
    apk_type: 'tracker',
    version: '1.0.0',
})

const uploadForm = ref({
    organization_id: auth.user?.organization_id ?? null,
    version: '',
    apk_file: null,
})

const hasActiveBuild = computed(() => builds.value.some((b) => b.status === 'pending' || b.status === 'building'))

const statusLabel = {
    pending: 'Menunggu antrean',
    building: 'Sedang build...',
    success: 'Berhasil',
    failed: 'Gagal',
}
const statusVariant = {
    pending: 'neutral',
    building: 'warning',
    success: 'success',
    failed: 'danger',
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
})
</script>

<template>
    <div>
        <PageHeader title="APK Builds" subtitle="Build APK tracker & master per site, langsung dari server">
            <template #actions>
                <BaseButton variant="ghost" @click="uploadDialogOpen = true"><Upload class="size-4" /> Unggah Manual</BaseButton>
                <BaseButton @click="generateDialogOpen = true"><Hammer class="size-4" /> Build & Unduh</BaseButton>
            </template>
        </PageHeader>

        <div class="p-8">
            <BaseCard title="Semua Build">
                <div v-if="loading" class="py-12 text-center text-sm text-base-500">Memuat...</div>
                <div v-else-if="builds.length === 0" class="py-12 text-center text-sm text-base-500">
                    Belum ada APK. Tekan "Build & Unduh" untuk membuat yang pertama.
                </div>
                <div v-else class="space-y-3">
                    <div
                        v-for="build in builds"
                        :key="build.id"
                        class="flex items-center justify-between rounded-xl border border-base-800 bg-base-850/60 p-4"
                    >
                        <div class="flex items-center gap-3">
                            <div class="flex size-10 items-center justify-center rounded-lg bg-base-800">
                                <Loader2 v-if="build.status === 'building' || build.status === 'pending'" class="size-5 animate-spin text-warning-400" />
                                <PackageOpen v-else class="size-5 text-base-400" />
                            </div>
                            <div>
                                <p class="font-medium text-base-100">
                                    {{ build.apk_type === 'master' ? 'APK Master' : (build.apk_type === 'server' ? 'Server' : 'APK Pelacak') }} v{{ build.version }} - {{ build.embedded_site_code }}
                                </p>
                                <p class="font-mono text-xs text-base-500">{{ build.checksum_sha256 ? `${build.checksum_sha256.slice(0, 24)}…` : '—' }}</p>
                                <p class="text-[11px] text-base-600">{{ dayjs(build.created_at).format('DD MMM YYYY HH:mm') }}</p>
                                <p v-if="build.status === 'failed' && build.build_log" class="mt-1 max-w-md truncate text-[11px] text-danger-400" :title="build.build_log">
                                    {{ build.build_log }}
                                </p>
                            </div>
                        </div>
                        <div class="flex items-center gap-3">
                            <BaseBadge :variant="statusVariant[build.status]">{{ statusLabel[build.status] }}</BaseBadge>
                            <a
                                v-if="build.download_url"
                                :href="build.download_url"
                                class="flex items-center gap-1.5 rounded-lg border border-base-700 px-3 py-2 text-xs text-base-300 hover:border-accent-500/50 hover:text-accent-300"
                            >
                                <Download class="size-3.5" /> Unduh
                            </a>
                        </div>
                    </div>
                </div>
            </BaseCard>
        </div>

        <DialogRoot :open="generateDialogOpen" @update:open="(v) => (generateDialogOpen = v)">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
                <DialogContent
                    class="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-base-800 bg-base-900 p-6 shadow-2xl"
                >
                    <DialogTitle class="text-base font-semibold text-base-50">Build APK Baru</DialogTitle>
                    <form class="mt-5 space-y-4" @submit.prevent="submitGenerate">
                        <label v-if="auth.isSuperAdmin" class="block">
                            <span class="mb-1.5 block text-xs font-medium text-base-300">Site</span>
                            <select
                                v-model="generateForm.organization_id"
                                class="w-full rounded-lg border border-base-700 bg-base-850 px-3.5 py-2.5 text-sm text-base-50 outline-none focus:border-accent-500"
                            >
                                <option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option>
                            </select>
                        </label>
                        <label class="block">
                            <span class="mb-1.5 block text-xs font-medium text-base-300">Tipe APK</span>
                            <select
                                v-model="generateForm.apk_type"
                                class="w-full rounded-lg border border-base-700 bg-base-850 px-3.5 py-2.5 text-sm text-base-50 outline-none focus:border-accent-500"
                            >
                                <option value="tracker">APK Pelacak (perangkat target)</option>
                                <option value="master">APK Master (admin/owner)</option>
                                <option value="server">Server (lacak-server.exe)</option>
                            </select>
                        </label>
                        <BaseInput v-model="generateForm.version" label="Versi" placeholder="1.0.0" required />
                        <p class="text-xs text-base-500">
                            Server menjalankan build Gradle sungguhan dengan kode site ditanam otomatis — butuh sekitar
                            1-2 menit, status diperbarui otomatis di daftar setelah ditutup.
                        </p>
                        <div class="flex justify-end gap-3 pt-2">
                            <BaseButton type="button" variant="ghost" @click="generateDialogOpen = false">Batal</BaseButton>
                            <BaseButton type="submit" :loading="generating">Mulai Build</BaseButton>
                        </div>
                    </form>
                </DialogContent>
            </DialogPortal>
        </DialogRoot>

        <DialogRoot :open="uploadDialogOpen" @update:open="(v) => (uploadDialogOpen = v)">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
                <DialogContent
                    class="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-base-800 bg-base-900 p-6 shadow-2xl"
                >
                    <DialogTitle class="text-base font-semibold text-base-50">Unggah APK Manual</DialogTitle>
                    <form class="mt-5 space-y-4" @submit.prevent="submitUpload">
                        <label v-if="auth.isSuperAdmin" class="block">
                            <span class="mb-1.5 block text-xs font-medium text-base-300">Site</span>
                            <select
                                v-model="uploadForm.organization_id"
                                class="w-full rounded-lg border border-base-700 bg-base-850 px-3.5 py-2.5 text-sm text-base-50 outline-none focus:border-accent-500"
                            >
                                <option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option>
                            </select>
                        </label>
                        <BaseInput v-model="uploadForm.version" label="Versi" placeholder="1.0.0" required />
                        <label class="block">
                            <span class="mb-1.5 block text-xs font-medium text-base-300">Berkas APK</span>
                            <input
                                type="file"
                                accept=".apk"
                                class="block w-full text-sm text-base-300 file:mr-3 file:rounded-lg file:border-0 file:bg-base-800 file:px-3 file:py-2 file:text-xs file:text-base-200"
                                required
                                @change="handleFileChange"
                            />
                        </label>
                        <p class="text-xs text-base-500">
                            Untuk APK yang sudah di-build sendiri di luar sistem ini. Kode site ditanam apa adanya dari
                            site yang dipilih, checksum dihitung server.
                        </p>
                        <div class="flex justify-end gap-3 pt-2">
                            <BaseButton type="button" variant="ghost" @click="uploadDialogOpen = false">Batal</BaseButton>
                            <BaseButton type="submit" :loading="submitting">Unggah</BaseButton>
                        </div>
                    </form>
                </DialogContent>
            </DialogPortal>
        </DialogRoot>
    </div>
</template>
