<script setup>
import { MapPinned, Pencil, Plus, Trash2 } from '@lucide/vue'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
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

const rules = ref([])
const organizations = ref([])
const loading = ref(true)
const dialogOpen = ref(false)
const submitting = ref(false)
const deleteTarget = ref(null)
const deleting = ref(false)
const editTarget = ref(null)

const emptyForm = () => ({
    organization_id: auth.user?.organization_id ?? null,
    rule_name: '',
    allowed_ssid: '',
    allowed_ip_cidr: '',
    max_distance_meters: 100,
})

const form = ref(emptyForm())

function openCreate() {
    editTarget.value = null
    form.value = emptyForm()
    dialogOpen.value = true
}

function openEdit(rule) {
    editTarget.value = rule
    form.value = {
        organization_id: rule.organization_id,
        rule_name: rule.rule_name,
        allowed_ssid: rule.allowed_ssid ?? '',
        allowed_ip_cidr: rule.allowed_ip_cidr ?? '',
        max_distance_meters: rule.max_distance_meters ?? 100,
    }
    dialogOpen.value = true
}

async function toggleActive(rule) {
    try {
        await api.put(`/geofence-rules/${rule.id}`, { is_active: !rule.is_active })
        toast.success(rule.is_active ? 'Aturan dinonaktifkan' : 'Aturan diaktifkan')
        await loadRules()
    } catch (err) {
        toast.error('Gagal mengubah status', err.response?.data?.message)
    }
}

async function loadRules() {
    loading.value = true
    try {
        const response = await api.get('/geofence-rules', { params: { per_page: 100 } })
        rules.value = response.data.data.items
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

async function submitForm() {
    submitting.value = true
    try {
        if (editTarget.value) {
            await api.put(`/geofence-rules/${editTarget.value.id}`, {
                rule_name: form.value.rule_name,
                allowed_ssid: form.value.allowed_ssid || null,
                allowed_ip_cidr: form.value.allowed_ip_cidr || null,
                max_distance_meters: form.value.max_distance_meters || null,
            })
            toast.success('Aturan geofence diperbarui')
        } else {
            await api.post('/geofence-rules', form.value)
            toast.success('Aturan geofence dibuat')
        }
        dialogOpen.value = false
        await loadRules()
    } catch (err) {
        toast.error(editTarget.value ? 'Gagal memperbarui aturan' : 'Gagal membuat aturan', err.response?.data?.message)
    } finally {
        submitting.value = false
    }
}

async function confirmDelete() {
    deleting.value = true
    try {
        await api.delete(`/geofence-rules/${deleteTarget.value.id}`)
        toast.success('Aturan dihapus')
        deleteTarget.value = null
        await loadRules()
    } catch (err) {
        toast.error('Gagal menghapus aturan', err.response?.data?.message)
    } finally {
        deleting.value = false
    }
}

onMounted(async () => {
    await Promise.all([loadRules(), loadOrganizations()])
})
</script>

<template>
    <div>
        <PageHeader title="Aturan Geofence" subtitle="Whitelist WiFi/IP dan jarak maksimum BLE per site">
            <template #actions>
                <BaseButton @click="openCreate"><Plus class="size-4" /> Tambah Aturan</BaseButton>
            </template>
        </PageHeader>

        <div class="p-8">
            <BaseCard title="Semua Aturan">
                <div v-if="loading" class="py-12 text-center text-sm text-base-500">Memuat...</div>
                <div v-else-if="rules.length === 0" class="py-12 text-center text-sm text-base-500">Belum ada aturan geofence.</div>
                <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <div v-for="rule in rules" :key="rule.id" class="rounded-xl border border-base-800 bg-base-850/60 p-4">
                        <div class="flex items-start justify-between">
                            <div class="flex items-center gap-2">
                                <MapPinned class="size-4 text-copper-400" />
                                <p class="font-medium text-base-100">{{ rule.rule_name }}</p>
                            </div>
                            <div class="flex items-center gap-2">
                                <button type="button" class="text-base-500 hover:text-accent-400" @click="openEdit(rule)">
                                    <Pencil class="size-4" />
                                </button>
                                <button type="button" class="text-base-500 hover:text-danger-400" @click="deleteTarget = rule">
                                    <Trash2 class="size-4" />
                                </button>
                            </div>
                        </div>
                        <dl class="mt-3 space-y-1 text-xs text-base-400">
                            <div v-if="rule.allowed_ssid">
                                <dt class="inline text-base-600">SSID:</dt>
                                {{ rule.allowed_ssid }}
                            </div>
                            <div v-if="rule.allowed_ip_cidr">
                                <dt class="inline text-base-600">IP:</dt>
                                {{ rule.allowed_ip_cidr }}
                            </div>
                            <div v-if="rule.max_distance_meters">
                                <dt class="inline text-base-600">Jarak maks:</dt>
                                {{ rule.max_distance_meters }}m
                            </div>
                        </dl>
                        <button type="button" @click="toggleActive(rule)">
                            <BaseBadge class="mt-3" :variant="rule.is_active ? 'success' : 'neutral'">
                                {{ rule.is_active ? 'Aktif' : 'Nonaktif' }}
                            </BaseBadge>
                        </button>
                    </div>
                </div>
            </BaseCard>
        </div>

        <DialogRoot :open="dialogOpen" @update:open="(v) => { dialogOpen = v; if (!v) editTarget = null }">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
                <DialogContent
                    class="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-base-800 bg-base-900 p-6 shadow-2xl"
                >
                    <DialogTitle class="text-base font-semibold text-base-50">
                        {{ editTarget ? 'Ubah Aturan Geofence' : 'Tambah Aturan Geofence' }}
                    </DialogTitle>
                    <form class="mt-5 space-y-4" @submit.prevent="submitForm">
                        <label v-if="auth.isSuperAdmin && !editTarget" class="block">
                            <span class="mb-1.5 block text-xs font-medium text-base-300">Site</span>
                            <select
                                v-model="form.organization_id"
                                class="w-full rounded-lg border border-base-700 bg-base-850 px-3.5 py-2.5 text-sm text-base-50 outline-none focus:border-accent-500"
                            >
                                <option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option>
                            </select>
                        </label>
                        <BaseInput v-model="form.rule_name" label="Nama Aturan" placeholder="Kantor Pusat" required />
                        <BaseInput v-model="form.allowed_ssid" label="SSID WiFi yang Diizinkan" placeholder="WIFI-KANTOR" />
                        <BaseInput v-model="form.allowed_ip_cidr" label="IP/CIDR yang Diizinkan" placeholder="192.168.1.0/24" />
                        <BaseInput v-model="form.max_distance_meters" type="number" label="Jarak BLE Maksimum (meter)" />
                        <div class="flex justify-end gap-3 pt-2">
                            <BaseButton type="button" variant="ghost" @click="dialogOpen = false">Batal</BaseButton>
                            <BaseButton type="submit" :loading="submitting">Simpan</BaseButton>
                        </div>
                    </form>
                </DialogContent>
            </DialogPortal>
        </DialogRoot>

        <ConfirmDialog
            :open="!!deleteTarget"
            title="Hapus aturan geofence ini?"
            :description="deleteTarget?.rule_name"
            confirm-label="Hapus"
            :loading="deleting"
            @update:open="(v) => !v && (deleteTarget = null)"
            @confirm="confirmDelete"
        />
    </div>
</template>
