<script setup>
import { Copy, Pencil, Plus, Trash2 } from '@lucide/vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { onMounted, ref } from 'vue'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'

const organizations = ref([])
const loading = ref(true)
const dialogOpen = ref(false)
const submitting = ref(false)
const toast = useToast()

const form = ref({ name: '', type: 'company_asset' })
const editingOrg = ref(null)

async function loadOrganizations() {
    loading.value = true
    try {
        const response = await api.get('/organizations')
        organizations.value = response.data.data.items
    } finally {
        loading.value = false
    }
}

async function submitForm() {
    submitting.value = true
    try {
        if (editingOrg.value) {
            await api.put(`/organizations/${editingOrg.value.id}`, form.value)
            toast.success('Nama site diubah')
        } else {
            await api.post('/organizations', form.value)
            toast.success('Site berhasil dibuat')
        }
        dialogOpen.value = false
        form.value = { name: '', type: 'company_asset' }
        editingOrg.value = null
        await loadOrganizations()
    } catch (err) {
        toast.error(editingOrg.value ? 'Gagal mengubah site' : 'Gagal membuat site', err.response?.data?.message)
    } finally {
        submitting.value = false
    }
}

function openEdit(org) {
    editingOrg.value = org
    form.value = { name: org.name, type: org.type ?? 'company_asset' }
    dialogOpen.value = true
}

async function removeSite(org) {
    if (!confirm(`Hapus site "${org.name}"? Semua data device/consent milik site ini ikut terhapus.`)) return
    try {
        await api.delete(`/organizations/${org.id}`)
        toast.success('Site dihapus')
        await loadOrganizations()
    } catch (err) {
        toast.error('Gagal menghapus site', err.response?.data?.message)
    }
}

function copySiteCode(code) {
    navigator.clipboard.writeText(code)
    toast.info('Kode site disalin', code)
}

onMounted(loadOrganizations)
</script>

<template>
    <div>
        <PageHeader title="Site / Organisasi" subtitle="LIST SITE TERDAFTAR">
            <template #actions>
                <BaseButton @click="dialogOpen = true; editingOrg = null"><Plus class="size-4" /> Tambah Site</BaseButton>
            </template>
        </PageHeader>

        <div class="p-8">
            <BaseCard title="Semua Site">
                <div v-if="loading" class="py-12 text-center text-sm text-base-500">Memuat...</div>
                <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <div v-for="org in organizations" :key="org.id" class="rounded-xl border border-base-800 bg-base-850/60 p-4">
                        <div class="flex items-start justify-between">
                            <p class="font-medium text-base-100">{{ org.name }}</p>
                            <BaseBadge :variant="org.is_active ? 'success' : 'neutral'">
                                {{ org.is_active ? 'Aktif' : 'Nonaktif' }}
                            </BaseBadge>
                        </div>
                        <p class="mt-1 text-xs text-base-500">{{ org.devices_count }} device</p>
                        <button
                            type="button"
                            class="mt-3 flex items-center gap-1.5 rounded-lg bg-base-800 px-2.5 py-1.5 font-mono text-xs text-base-300 hover:text-accent-300"
                            @click="copySiteCode(org.unique_site_code)"
                        >
                            <Copy class="size-3" /> {{ org.unique_site_code }}
                        </button>
                        <div class="mt-3 flex items-center gap-2">
                            <button
                                type="button"
                                class="flex items-center gap-1.5 rounded-lg border border-base-700 px-2.5 py-1.5 text-xs text-base-300 hover:border-accent-500/50 hover:text-accent-300"
                                @click="openEdit(org)"
                            >
                                <Pencil class="size-3" /> Ubah Nama
                            </button>
                            <button
                                type="button"
                                class="flex items-center gap-1.5 rounded-lg border border-base-700 px-2.5 py-1.5 text-xs text-base-300 hover:border-danger-500/50 hover:text-danger-300"
                                @click="removeSite(org)"
                            >
                                <Trash2 class="size-3" /> Hapus
                            </button>
                        </div>
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
                    <DialogTitle class="text-base font-semibold text-base-50">{{ editingOrg ? `Ubah Nama Site: ${editingOrg.name}` : 'Tambah Site Baru' }}</DialogTitle>
                    <DialogDescription class="sr-only">Formulir untuk mengubah atau menambah data site</DialogDescription>
                    <form class="mt-5 space-y-4" @submit.prevent="submitForm">
                        <BaseInput v-model="form.name" label="Nama Site" placeholder="PT Contoh Logistik" required />
                        <p class="text-xs text-base-500">
                            Kode unik site akan dibuat otomatis oleh sistem (mengikuti nama site) dan ditanam ke APK yang didownload untuk site ini.
                        </p>
                        <div class="flex justify-end gap-3 pt-2">
                            <BaseButton type="button" variant="ghost" @click="dialogOpen = false; editingOrg = null">Batal</BaseButton>
                            <BaseButton type="submit" :loading="submitting">{{ editingOrg ? 'Simpan' : 'Buat Site' }}</BaseButton>
                        </div>
                    </form>
                </DialogContent>
            </DialogPortal>
        </DialogRoot>
    </div>
</template>
