<script setup>
import { ExternalLink, FileSignature, Plus, ShieldOff } from '@lucide/vue'
import dayjs from 'dayjs'
import { computed, onMounted, ref } from 'vue'

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

const SIGNER_ROLES = {
    hrd: 'HRD',
    leader: 'Leader',
    asisten_manager: 'Asisten Manager',
    manager: 'Manager',
    cs_line: 'CS Line',
}

const activeCount = computed(() => documents.value.filter((doc) => doc.is_active).length)

function menuItems(doc) {
    return [{ label: 'Cabut consent', icon: ShieldOff, onSelect: () => (revokeTarget.value = doc), danger: true, hidden: !doc.is_active }]
}

onMounted(async () => {
    await Promise.all([loadDocuments(), loadOrganizations()])
})
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Perangkat"
            title="Dokumen consent"
            subtitle="Persetujuan tertulis dari pemegang device. Tanpa consent yang berlaku, device tidak bisa menerima perintah selain buka kunci."
        >
            <template #actions>
                <BaseButton @click="dialogOpen = true"><Plus class="size-4" /> Tambah consent</BaseButton>
            </template>
            <template v-if="!loading" #readouts>
                <Readout label="Dokumen" :value="documents.length" />
                <Readout label="Berlaku" :value="activeCount" led="accent" />
                <Readout
                    label="Dicabut"
                    :value="documents.length - activeCount"
                    :led="documents.length - activeCount ? 'danger' : 'muted'"
                />
            </template>
        </PageHeader>

        <div class="p-4 sm:p-8">
            <BaseCard title="Semua dokumen" :count="loading ? null : documents.length" flush>
                <div v-if="loading" class="px-5 py-12 text-center text-sm text-base-500">Memuat dokumen…</div>
                <EmptyState
                    v-else-if="documents.length === 0"
                    :icon="FileSignature"
                    title="Belum ada dokumen consent"
                    description="Unggah surat persetujuan yang sudah ditandatangani sebelum membuat APK pelacak untuk seseorang."
                >
                    <BaseButton @click="dialogOpen = true"><Plus class="size-4" /> Tambah consent</BaseButton>
                </EmptyState>
                <div v-else class="overflow-x-auto">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Subjek</th>
                                <th class="hidden md:table-cell">Penandatangan</th>
                                <th class="hidden sm:table-cell">Ditandatangani</th>
                                <th class="hidden lg:table-cell">Berlaku sampai</th>
                                <th>Status</th>
                                <th class="w-0"><span class="sr-only">Aksi</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="doc in documents" :key="doc.id">
                                <td>
                                    <p class="font-medium text-base-50">{{ doc.subject_name }}</p>
                                    <p v-if="organizations.length > 1" class="text-xs text-base-500">
                                        {{ organizations.find((o) => o.id === doc.organization_id)?.name }}
                                    </p>
                                </td>
                                <td class="hidden md:table-cell">
                                    <p class="text-base-200">{{ doc.signer_name }}</p>
                                    <p class="text-xs text-base-500">{{ SIGNER_ROLES[doc.signer_role] ?? doc.signer_role }}</p>
                                </td>
                                <td class="hidden font-mono text-xs text-base-300 tabular-nums sm:table-cell">
                                    {{ dayjs(doc.signed_at).format('DD MMM YYYY') }}
                                </td>
                                <td class="hidden font-mono text-xs text-base-400 tabular-nums lg:table-cell">
                                    {{ doc.valid_until ? dayjs(doc.valid_until).format('DD MMM YYYY') : 'Tanpa batas' }}
                                </td>
                                <td>
                                    <StatusDot
                                        :status="doc.is_active ? 'active' : 'failed'"
                                        :label="doc.is_active ? 'Berlaku' : 'Dicabut'"
                                    />
                                </td>
                                <td>
                                    <div class="flex items-center justify-end gap-1">
                                        <a
                                            :href="doc.document_url"
                                            target="_blank"
                                            rel="noopener"
                                            class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-base-700 px-3 text-xs font-medium whitespace-nowrap text-base-100 transition-colors hover:border-base-500 hover:bg-base-850 focus-visible:outline-2 focus-visible:outline-accent-400"
                                        >
                                            <ExternalLink class="size-3.5" /> <span class="max-sm:sr-only">Lihat berkas</span>
                                        </a>
                                        <RowMenu
                                            v-if="doc.is_active"
                                            :items="menuItems(doc)"
                                            :label="`Aksi untuk consent ${doc.subject_name}`"
                                        />
                                        <span v-else class="size-8" aria-hidden="true" />
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </BaseCard>
        </div>

        <BaseDialog
            :open="dialogOpen"
            title="Tambah dokumen consent"
            description="Unggah hasil pindaian atau foto surat yang sudah ditandatangani."
            @update:open="(v) => (dialogOpen = v)"
        >
            <form id="consent-form" class="space-y-4" @submit.prevent="submitForm">
                <BaseSelect v-if="auth.isSuperAdmin" v-model="form.organization_id" label="Site" required>
                    <option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option>
                </BaseSelect>
                <BaseInput v-model="form.subject_name" label="Nama pemegang device" hint="Orang yang device-nya akan dipantau." required />
                <div class="grid gap-4 sm:grid-cols-2">
                    <BaseInput v-model="form.signer_name" label="Nama penandatangan" required />
                    <BaseSelect v-model="form.signer_role" label="Jabatan penandatangan">
                        <option v-for="(label, value) in SIGNER_ROLES" :key="value" :value="value">{{ label }}</option>
                    </BaseSelect>
                </div>
                <div class="grid gap-4 sm:grid-cols-2">
                    <BaseInput v-model="form.signed_at" type="date" label="Tanggal tanda tangan" required />
                    <BaseInput v-model="form.valid_until" type="date" label="Berlaku sampai" hint="Kosongkan bila tanpa batas." />
                </div>
                <label class="block">
                    <span class="field-label">Berkas surat <span class="text-danger-400" aria-hidden="true">*</span></span>
                    <input type="file" accept=".pdf,.jpg,.jpeg,.png" class="file-control" required @change="handleFileChange" />
                    <span class="field-hint block">PDF, JPG, atau PNG.</span>
                </label>
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="dialogOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="consent-form" :loading="submitting">Simpan consent</BaseButton>
            </template>
        </BaseDialog>

        <ConfirmDialog
            :open="!!revokeTarget"
            :title="`Cabut consent ${revokeTarget?.subject_name ?? ''}?`"
            description="Device milik orang ini tidak lagi bisa menerima perintah apa pun selain buka kunci."
            confirm-label="Cabut consent"
            :loading="revoking"
            @update:open="(v) => !v && (revokeTarget = null)"
            @confirm="confirmRevoke"
        />
    </div>
</template>
