<script setup>
import { Download, PackageOpen, Upload } from '@lucide/vue'
import dayjs from 'dayjs'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { onMounted, ref } from 'vue'

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
const dialogOpen = ref(false)
const submitting = ref(false)

const form = ref({
    organization_id: auth.user?.organization_id ?? null,
    version: '',
    apk_file: null,
})

async function loadBuilds() {
    loading.value = true
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
    if (!form.value.organization_id && organizations.value.length) {
        form.value.organization_id = organizations.value[0].id
    }
}

function handleFileChange(event) {
    form.value.apk_file = event.target.files[0] ?? null
}

async function submitForm() {
    submitting.value = true
    try {
        const payload = new FormData()
        payload.append('organization_id', form.value.organization_id)
        payload.append('version', form.value.version)
        payload.append('apk_file', form.value.apk_file)

        await api.post('/apk-builds', payload, {
            headers: { 'Content-Type': 'multipart/form-data' },
        })
        toast.success('APK berhasil diunggah')
        dialogOpen.value = false
        await loadBuilds()
    } catch (err) {
        toast.error('Gagal mengunggah APK', err.response?.data?.message)
    } finally {
        submitting.value = false
    }
}

onMounted(async () => {
    await Promise.all([loadBuilds(), loadOrganizations()])
})
</script>

<template>
    <div>
        <PageHeader title="APK Builds" subtitle="Registry APK pelacak per site, dengan checksum anti-duplikasi">
            <template #actions>
                <BaseButton @click="dialogOpen = true"><Upload class="size-4" /> Unggah APK</BaseButton>
            </template>
        </PageHeader>

        <div class="p-8">
            <BaseCard title="Semua Build">
                <div v-if="loading" class="py-12 text-center text-sm text-base-500">Memuat...</div>
                <div v-else-if="builds.length === 0" class="py-12 text-center text-sm text-base-500">Belum ada APK diunggah.</div>
                <div v-else class="space-y-3">
                    <div
                        v-for="build in builds"
                        :key="build.id"
                        class="flex items-center justify-between rounded-xl border border-base-800 bg-base-850/60 p-4"
                    >
                        <div class="flex items-center gap-3">
                            <div class="flex size-10 items-center justify-center rounded-lg bg-base-800">
                                <PackageOpen class="size-5 text-base-400" />
                            </div>
                            <div>
                                <p class="font-medium text-base-100">v{{ build.version }} — {{ build.embedded_site_code }}</p>
                                <p class="font-mono text-xs text-base-500">{{ build.checksum_sha256.slice(0, 24) }}…</p>
                                <p class="text-[11px] text-base-600">{{ dayjs(build.created_at).format('DD MMM YYYY HH:mm') }}</p>
                            </div>
                        </div>
                        <a
                            :href="build.download_url"
                            class="flex items-center gap-1.5 rounded-lg border border-base-700 px-3 py-2 text-xs text-base-300 hover:border-accent-500/50 hover:text-accent-300"
                        >
                            <Download class="size-3.5" /> Unduh
                        </a>
                    </div>
                </div>
            </BaseCard>
        </div>

        <DialogRoot :open="dialogOpen" @update:open="(v) => (dialogOpen = v)">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
                <DialogContent
                    class="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-base-800 bg-base-900 p-6 shadow-2xl"
                >
                    <DialogTitle class="text-base font-semibold text-base-50">Unggah APK Baru</DialogTitle>
                    <form class="mt-5 space-y-4" @submit.prevent="submitForm">
                        <label v-if="auth.isSuperAdmin" class="block">
                            <span class="mb-1.5 block text-xs font-medium text-base-300">Site</span>
                            <select
                                v-model="form.organization_id"
                                class="w-full rounded-lg border border-base-700 bg-base-850 px-3.5 py-2.5 text-sm text-base-50 outline-none focus:border-accent-500"
                            >
                                <option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option>
                            </select>
                        </label>
                        <BaseInput v-model="form.version" label="Versi" placeholder="1.0.0" required />
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
                            Kode site akan ditanam otomatis dan checksum dihitung server untuk mendeteksi APK bajakan/duplikat.
                        </p>
                        <div class="flex justify-end gap-3 pt-2">
                            <BaseButton type="button" variant="ghost" @click="dialogOpen = false">Batal</BaseButton>
                            <BaseButton type="submit" :loading="submitting">Unggah</BaseButton>
                        </div>
                    </form>
                </DialogContent>
            </DialogPortal>
        </DialogRoot>
    </div>
</template>
