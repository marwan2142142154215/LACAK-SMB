<script setup>
import { AlertTriangle, MapPinned, Pencil, Plus, Trash2 } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import BaseButton from '@/components/ui/BaseButton.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const toast = useToast()

const rules = ref([])
const organizations = ref([])
const devices = ref([])
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
    center_latitude: '',
    center_longitude: '',
    anchor_device_id: '',
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
        center_latitude: rule.center_latitude ?? '',
        center_longitude: rule.center_longitude ?? '',
        anchor_device_id: rule.anchor_device_id ?? '',
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

async function loadDevices() {
    const response = await api.get('/devices', { params: { per_page: 100 } })
    devices.value = response.data.data.items
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
                center_latitude: form.value.center_latitude || null,
                center_longitude: form.value.center_longitude || null,
                anchor_device_id: form.value.anchor_device_id || null,
            })
            toast.success('Aturan geofence diperbarui')
        } else {
            await api.post('/geofence-rules', {
                ...form.value,
                center_latitude: form.value.center_latitude || null,
                center_longitude: form.value.center_longitude || null,
                anchor_device_id: form.value.anchor_device_id || null,
            })
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

const activeCount = computed(() => rules.value.filter((rule) => rule.is_active).length)
const bleCount = computed(() => rules.value.filter((rule) => rule.anchor_device_id).length)

function siteName(rule) {
    return organizations.value.find((org) => org.id === rule.organization_id)?.name ?? null
}

// Syarat yang diperiksa satu aturan, ditampilkan sebagai baris readout
function conditions(rule) {
    const rows = []
    if (rule.allowed_ssid) rows.push({ label: 'WiFi', value: rule.allowed_ssid })
    if (rule.allowed_ip_cidr) rows.push({ label: 'IP', value: rule.allowed_ip_cidr })
    if (rule.max_distance_meters && rule.anchor_device_id) {
        rows.push({ label: 'BLE', value: `≤ ${rule.max_distance_meters} m dari ${rule.anchor_device_name ?? 'device anchor'}` })
    } else if (rule.max_distance_meters) {
        rows.push({ label: 'GPS', value: `≤ ${rule.max_distance_meters} m dari titik pusat`, warning: rule.center_latitude == null })
    }
    return rows
}

function menuItems(rule) {
    return [
        { label: 'Ubah aturan', icon: Pencil, onSelect: () => openEdit(rule) },
        { label: 'Hapus aturan', icon: Trash2, onSelect: () => (deleteTarget.value = rule), danger: true },
    ]
}

onMounted(async () => {
    await Promise.all([loadRules(), loadOrganizations(), loadDevices()])
})
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Perangkat"
            title="Aturan geofence"
            subtitle="Batas aman tiap site lewat WiFi, IP, radius GPS, atau jarak BLE. Device dikunci otomatis saat keluar batas dan dibuka lagi saat kembali."
        >
            <template #actions>
                <BaseButton @click="openCreate"><Plus class="size-4" /> Tambah aturan</BaseButton>
            </template>
            <template v-if="!loading" #readouts>
                <Readout label="Aturan" :value="rules.length" />
                <Readout label="Aktif" :value="activeCount" led="accent" />
                <Readout label="Pakai BLE" :value="bleCount" led="copper" />
            </template>
        </PageHeader>

        <div class="p-4 sm:p-8">
            <div v-if="loading" class="py-12 text-center text-sm text-base-500">Memuat aturan…</div>
            <div v-else-if="rules.length === 0" class="rounded-xl border border-base-800 bg-base-900/70">
                <EmptyState
                    :icon="MapPinned"
                    title="Belum ada aturan geofence"
                    description="Tanpa aturan, device tidak pernah dikunci otomatis. Mulai dari WiFi kantor atau radius GPS di sekitar site."
                >
                    <BaseButton @click="openCreate"><Plus class="size-4" /> Tambah aturan</BaseButton>
                </EmptyState>
            </div>
            <ul v-else class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                <li
                    v-for="rule in rules"
                    :key="rule.id"
                    class="flex flex-col rounded-xl border bg-base-900/70 p-5 transition-colors"
                    :class="rule.is_active ? 'border-base-800 hover:border-base-700' : 'border-dashed border-base-800'"
                >
                    <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                            <p v-if="siteName(rule)" class="eyebrow">{{ siteName(rule) }}</p>
                            <h2
                                class="mt-1 font-display text-lg leading-snug font-bold tracking-[-0.015em]"
                                :class="rule.is_active ? 'text-base-50' : 'text-base-400'"
                            >
                                {{ rule.rule_name }}
                            </h2>
                        </div>
                        <RowMenu :items="menuItems(rule)" :label="`Aksi untuk ${rule.rule_name}`" />
                    </div>

                    <dl class="mt-4 flex-1 space-y-2">
                        <div v-for="row in conditions(rule)" :key="row.label" class="flex items-baseline gap-3 text-sm">
                            <dt class="eyebrow w-10 shrink-0">{{ row.label }}</dt>
                            <dd class="min-w-0 font-mono text-[13px] break-words text-base-200">
                                {{ row.value }}
                                <span v-if="row.warning" class="mt-1 flex items-center gap-1.5 font-sans text-xs text-warning-400">
                                    <AlertTriangle class="size-3.5" /> Titik pusat belum diisi, radius ini belum berlaku.
                                </span>
                            </dd>
                        </div>
                        <p v-if="conditions(rule).length === 0" class="text-xs text-base-500">
                            Belum ada syarat. Ubah aturan untuk menambahkan WiFi, IP, atau radius.
                        </p>
                    </dl>

                    <div class="mt-5 flex items-center justify-between border-t border-base-800 pt-4">
                        <span class="text-xs" :class="rule.is_active ? 'text-base-300' : 'text-base-500'">
                            {{ rule.is_active ? 'Mengunci otomatis' : 'Tidak dijalankan' }}
                        </span>
                        <button
                            type="button"
                            role="switch"
                            :aria-checked="rule.is_active"
                            :aria-label="`Jalankan aturan ${rule.rule_name}`"
                            class="relative h-5 w-9 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400"
                            :class="rule.is_active ? 'bg-accent-500' : 'bg-base-700'"
                            @click="toggleActive(rule)"
                        >
                            <span
                                class="absolute top-0.5 left-0.5 size-4 rounded-full bg-base-50 shadow transition-transform"
                                :class="rule.is_active ? 'translate-x-4' : 'translate-x-0'"
                            />
                        </button>
                    </div>
                </li>
            </ul>
        </div>

        <BaseDialog
            :open="dialogOpen"
            :title="editTarget ? `Ubah aturan ${editTarget.rule_name}` : 'Tambah aturan geofence'"
            description="Isi minimal satu syarat. Device dianggap aman bila memenuhi syarat yang diisi."
            @update:open="
                (v) => {
                    dialogOpen = v
                    if (!v) editTarget = null
                }
            "
        >
            <form id="geofence-form" class="space-y-4" @submit.prevent="submitForm">
                <BaseSelect v-if="auth.isSuperAdmin && !editTarget" v-model="form.organization_id" label="Site" required>
                    <option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option>
                </BaseSelect>
                <BaseInput v-model="form.rule_name" label="Nama aturan" placeholder="Kantor Pusat" required />

                <fieldset class="space-y-4 border-t border-base-800 pt-4">
                    <legend class="eyebrow mb-1 pr-2">Jaringan</legend>
                    <div class="grid gap-4 sm:grid-cols-2">
                        <BaseInput v-model="form.allowed_ssid" label="SSID WiFi" placeholder="WIFI-KANTOR" />
                        <BaseInput v-model="form.allowed_ip_cidr" label="IP / CIDR" placeholder="192.168.1.0/24" />
                    </div>
                </fieldset>

                <fieldset class="space-y-4 border-t border-base-800 pt-4">
                    <legend class="eyebrow mb-1 pr-2">Jarak</legend>
                    <BaseSelect
                        v-model="form.anchor_device_id"
                        label="Ukur dari"
                        hint="BLE lebih presisi di dalam ruangan dan tidak butuh GPS."
                    >
                        <option value="">Titik pusat GPS</option>
                        <option v-for="d in devices" :key="d.id" :value="d.id">Device anchor BLE: {{ d.device_name }}</option>
                    </BaseSelect>
                    <div v-if="!form.anchor_device_id" class="grid gap-4 sm:grid-cols-2">
                        <BaseInput
                            v-model="form.center_latitude"
                            type="number"
                            step="any"
                            label="Latitude titik pusat"
                            placeholder="3.5946933"
                        />
                        <BaseInput
                            v-model="form.center_longitude"
                            type="number"
                            step="any"
                            label="Longitude titik pusat"
                            placeholder="98.6727733"
                        />
                    </div>
                    <BaseInput
                        v-model="form.max_distance_meters"
                        type="number"
                        label="Radius aman (meter)"
                        :hint="
                            form.anchor_device_id
                                ? 'Device dikunci bila jaraknya ke anchor (perkiraan dari kekuatan sinyal) melebihi radius ini.'
                                : 'Ambil latitude/longitude dari Google Maps lokasi site. Tanpa titik pusat, radius tidak berlaku.'
                        "
                    />
                </fieldset>
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="dialogOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="geofence-form" :loading="submitting">{{
                    editTarget ? 'Simpan aturan' : 'Buat aturan'
                }}</BaseButton>
            </template>
        </BaseDialog>

        <ConfirmDialog
            :open="!!deleteTarget"
            :title="`Hapus aturan ${deleteTarget?.rule_name ?? ''}?`"
            description="Device di site ini tidak lagi dikunci otomatis berdasarkan aturan ini."
            confirm-label="Hapus aturan"
            :loading="deleting"
            @update:open="(v) => !v && (deleteTarget = null)"
            @confirm="confirmDelete"
        />
    </div>
</template>
