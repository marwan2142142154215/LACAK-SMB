<script setup>
import { Building2, Copy, Pencil, Plus, Trash2 } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import BaseButton from '@/components/ui/BaseButton.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import StatusDot from '@/components/ui/StatusDot.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'

const organizations = ref([])
const loading = ref(true)
const dialogOpen = ref(false)
const submitting = ref(false)
const toast = useToast()

const form = ref({ name: '', type: 'company_asset' })
const editingOrg = ref(null)
const deleteTarget = ref(null)
const deleting = ref(false)
const deleteTitle = computed(() => (deleteTarget.value ? `Hapus site "${deleteTarget.value.name}"?` : ''))

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

async function confirmDelete() {
    deleting.value = true
    try {
        await api.delete(`/organizations/${deleteTarget.value.id}`)
        toast.success('Site dihapus')
        deleteTarget.value = null
        await loadOrganizations()
    } catch (err) {
        toast.error('Gagal menghapus site', err.response?.data?.message)
    } finally {
        deleting.value = false
    }
}

function copySiteCode(code) {
    navigator.clipboard.writeText(code)
    toast.info('Kode site disalin', code)
}

function openCreate() {
    editingOrg.value = null
    form.value = { name: '', type: 'company_asset' }
    dialogOpen.value = true
}

const totalDevices = computed(() => organizations.value.reduce((total, org) => total + (org.devices_count ?? 0), 0))

function menuItems(org) {
    return [
        { label: 'Ubah nama', icon: Pencil, onSelect: () => openEdit(org) },
        { label: 'Hapus site', icon: Trash2, onSelect: () => (deleteTarget.value = org), danger: true },
    ]
}

onMounted(loadOrganizations)
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Akses"
            title="Site"
            subtitle="Setiap site punya kode unik yang ditanam ke APK pelacak miliknya. Data antar site tidak saling terlihat."
        >
            <template #actions>
                <BaseButton @click="openCreate"><Plus class="size-4" /> Tambah site</BaseButton>
            </template>
            <template v-if="!loading" #readouts>
                <Readout label="Site" :value="organizations.length" />
                <Readout label="Aktif" :value="organizations.filter((o) => o.is_active).length" led="accent" />
                <Readout label="Device terdaftar" :value="totalDevices" />
            </template>
        </PageHeader>

        <div class="p-4 sm:p-8">
            <div v-if="loading" class="py-12 text-center text-sm text-base-500">Memuat site…</div>
            <div v-else-if="organizations.length === 0" class="rounded-xl border border-base-800 bg-base-900/70">
                <EmptyState
                    :icon="Building2"
                    title="Belum ada site"
                    description="Buat site pertama, lalu tambahkan staf dan build APK pelacak untuk site itu."
                >
                    <BaseButton @click="openCreate"><Plus class="size-4" /> Tambah site</BaseButton>
                </EmptyState>
            </div>
            <ul v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <li
                    v-for="org in organizations"
                    :key="org.id"
                    class="flex flex-col rounded-xl border border-base-800 bg-base-900/70 p-5 transition-colors hover:border-base-700"
                >
                    <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                            <StatusDot :status="org.is_active ? 'active' : 'inactive'" />
                            <h2 class="mt-2 font-display text-lg leading-snug font-bold text-base-50 tracking-[-0.015em]">{{ org.name }}</h2>
                        </div>
                        <RowMenu :items="menuItems(org)" :label="`Aksi untuk ${org.name}`" />
                    </div>

                    <dl class="mt-5 grid grid-cols-2 gap-4 border-t border-base-800 pt-4">
                        <div>
                            <dt class="eyebrow">Device</dt>
                            <dd class="mt-1 font-mono text-xl text-base-50 tabular-nums">{{ org.devices_count ?? 0 }}</dd>
                        </div>
                        <div class="min-w-0">
                            <dt class="eyebrow">Kode site</dt>
                            <dd class="mt-1">
                                <button
                                    type="button"
                                    class="group inline-flex max-w-full items-center gap-1.5 rounded font-mono text-sm text-base-200 hover:text-accent-300 focus-visible:outline-2 focus-visible:outline-accent-400"
                                    :title="`Salin kode ${org.unique_site_code}`"
                                    @click="copySiteCode(org.unique_site_code)"
                                >
                                    <span class="truncate">{{ org.unique_site_code }}</span>
                                    <Copy class="size-3.5 shrink-0 text-base-500 group-hover:text-accent-300" />
                                </button>
                            </dd>
                        </div>
                    </dl>
                </li>
            </ul>
        </div>

        <BaseDialog
            :open="dialogOpen"
            :title="editingOrg ? `Ubah nama ${editingOrg.name}` : 'Tambah site'"
            :description="
                editingOrg
                    ? 'Kode site tidak berubah, jadi APK yang sudah terpasang tetap terhubung.'
                    : 'Kode unik site dibuat otomatis dari namanya.'
            "
            size="sm"
            @update:open="
                (v) => {
                    dialogOpen = v
                    if (!v) editingOrg = null
                }
            "
        >
            <form id="site-form" @submit.prevent="submitForm">
                <BaseInput v-model="form.name" label="Nama site" placeholder="PT Contoh Logistik" required />
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="dialogOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="site-form" :loading="submitting">{{ editingOrg ? 'Simpan nama' : 'Buat site' }}</BaseButton>
            </template>
        </BaseDialog>

        <ConfirmDialog
            :open="!!deleteTarget"
            :title="deleteTitle"
            description="Semua device dan dokumen consent milik site ini ikut terhapus."
            confirm-label="Hapus site"
            :loading="deleting"
            @update:open="(v) => !v && (deleteTarget = null)"
            @confirm="confirmDelete"
        />
    </div>
</template>
