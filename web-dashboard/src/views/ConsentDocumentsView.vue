<script setup>
import { FileText, Plus, ShieldOff } from '@lucide/vue'
import dayjs from 'dayjs'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { onMounted, ref } from 'vue'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const toast = useToast()

const documents = ref([])
const organizations = ref([])
const loading = ref(true)
const dialogOpen = ref(false)
const submitting = ref(false)
const revokeTarget = ref(null)
const revoking = ref(false)

const form = ref({
    organization_id: auth.user?.organization_id ?? null,
    subject_name: '',
    signer_name: '',
    signer_role: 'hrd',
    signed_at: dayjs().format('YYYY-MM-DD'),
    valid_until: '',
    document_file: null,
})

async function loadDocuments() {
    loading.value = true
    try {
        const response = await api.get('/consent-documents', { params: { per_page: 100 } })
        documents.value = response.data.data.items
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
    form.value.document_file = event.target.files[0] ?? null
}

async function submitForm() {
    submitting.value = true
    try {
        const payload = new FormData()
        payload.append('organization_id', form.value.organization_id)
        payload.append('subject_name', form.value.subject_name)
        payload.append('signer_name', form.value.signer_name)
        payload.append('signer_role', form.value.signer_role)
        payload.append('signed_at', form.value.signed_at)
        if (form.value.valid_until) payload.append('valid_until', form.value.valid_until)
        payload.append('document_file', form.value.document_file)

        await api.post('/consent-documents', payload, {
            headers: { 'Content-Type': 'multipart/form-data' },
        })
        toast.success('Dokumen consent berhasil disimpan')
        dialogOpen.value = false
        await loadDocuments()
    } catch (err) {
        toast.error('Gagal menyimpan dokumen', err.response?.data?.message)
    } finally {
        submitting.value = false
    }
}

async function confirmRevoke() {
    revoking.value = true
    try {
        await api.post(`/consent-documents/${revokeTarget.value.id}/revoke`)
        toast.success('Consent dicabut')
        revokeTarget.value = null
        await loadDocuments()
    } catch (err) {
        toast.error('Gagal mencabut consent', err.response?.data?.message)
    } finally {
        revoking.value = false
    }
}

onMounted(async () => {
    await Promise.all([loadDocuments(), loadOrganizations()])
})
</script>

<template>
    <div>
        <PageHeader title="Dokumen Consent" subtitle="Dasar hukum setiap device yang dipantau — wajib ada sebelum device bisa dikelola">
            <template #actions>
                <BaseButton @click="dialogOpen = true"><Plus class="size-4" /> Tambah Consent</BaseButton>
            </template>
        </PageHeader>

        <div class="p-8">
            <BaseCard title="Semua Dokumen">
                <div v-if="loading" class="py-12 text-center text-sm text-base-500">Memuat...</div>
                <div v-else-if="documents.length === 0" class="py-12 text-center text-sm text-base-500">Belum ada dokumen consent.</div>
                <div v-else class="space-y-3">
                    <div
                        v-for="doc in documents"
                        :key="doc.id"
                        class="flex items-center justify-between rounded-xl border border-base-800 bg-base-850/60 p-4"
                    >
                        <div class="flex items-center gap-3">
                            <div class="flex size-10 items-center justify-center rounded-lg bg-base-800">
                                <FileText class="size-5 text-base-400" />
                            </div>
                            <div>
                                <p class="font-medium text-base-100">{{ doc.subject_name }}</p>
                                <p class="text-xs text-base-500">
                                    Ditandatangani {{ doc.signer_name }} ({{ doc.signer_role }}) ·
                                    {{ dayjs(doc.signed_at).format('DD MMM YYYY') }}
                                </p>
                            </div>
                        </div>
                        <div class="flex items-center gap-3">
                            <BaseBadge :variant="doc.is_active ? 'success' : 'danger'">
                                {{ doc.is_active ? 'Berlaku' : 'Tidak Berlaku' }}
                            </BaseBadge>
                            <a :href="doc.document_url" target="_blank" class="text-xs text-accent-400 hover:underline">Lihat</a>
                            <BaseButton v-if="doc.is_active" size="sm" variant="danger" @click="revokeTarget = doc">
                                <ShieldOff class="size-3.5" /> Cabut
                            </BaseButton>
                        </div>
                    </div>
                </div>
            </BaseCard>
        </div>

        <DialogRoot :open="dialogOpen" @update:open="(v) => (dialogOpen = v)">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
                <DialogContent
                    class="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-full max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-base-800 bg-base-900 p-6 shadow-2xl"
                >
                    <DialogTitle class="text-base font-semibold text-base-50">Tambah Dokumen Consent</DialogTitle>
                    <DialogDescription class="sr-only">Formulir untuk menambah dokumen consent baru</DialogDescription>
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
                        <BaseInput v-model="form.subject_name" label="Nama Subjek (anak/staf)" required />
                        <BaseInput v-model="form.signer_name" label="Nama Penandatangan" required />
                        <label class="block">
                            <span class="mb-1.5 block text-xs font-medium text-base-300">Peran Penandatangan</span>
                            <select
                                v-model="form.signer_role"
                                class="w-full rounded-lg border border-base-700 bg-base-850 px-3.5 py-2.5 text-sm text-base-50 outline-none focus:border-accent-500"
                            >
                                <option value="hrd">HRD</option>
                                <option value="leader">Leader</option>
                                <option value="asisten_manager">Asisten Manager</option>
                                <option value="manager">Manager</option>
                                <option value="cs_line">CS Line</option>
                            </select>
                        </label>
                        <BaseInput v-model="form.signed_at" type="date" label="Tanggal Tanda Tangan" required />
                        <BaseInput v-model="form.valid_until" type="date" label="Berlaku Sampai (opsional)" />
                        <label class="block">
                            <span class="mb-1.5 block text-xs font-medium text-base-300">Berkas (PDF/JPG/PNG)</span>
                            <input
                                type="file"
                                accept=".pdf,.jpg,.jpeg,.png"
                                class="block w-full text-sm text-base-300 file:mr-3 file:rounded-lg file:border-0 file:bg-base-800 file:px-3 file:py-2 file:text-xs file:text-base-200"
                                required
                                @change="handleFileChange"
                            />
                        </label>
                        <div class="flex justify-end gap-3 pt-2">
                            <BaseButton type="button" variant="ghost" @click="dialogOpen = false">Batal</BaseButton>
                            <BaseButton type="submit" :loading="submitting">Simpan</BaseButton>
                        </div>
                    </form>
                </DialogContent>
            </DialogPortal>
        </DialogRoot>

        <ConfirmDialog
            :open="!!revokeTarget"
            title="Cabut dokumen consent ini?"
            :description="`Device yang terkait ${revokeTarget?.subject_name} tidak akan lagi bisa menerima perintah apa pun kecuali unlock.`"
            confirm-label="Cabut"
            :loading="revoking"
            @update:open="(v) => !v && (revokeTarget = null)"
            @confirm="confirmRevoke"
        />
    </div>
</template>
