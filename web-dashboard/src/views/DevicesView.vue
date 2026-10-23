<script setup>
import { KeyRound, Lock, MapPin, Pencil, PlayCircle, RefreshCw, Search, Smartphone, StopCircle, Trash2, Unlock } from '@lucide/vue'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { computed, onMounted, ref } from 'vue'

import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
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

const devices = ref([])
const loading = ref(true)
const actingDeviceId = ref(null)
const otpResult = ref(null)
const toast = useToast()
const renameTarget = ref(null)
const renameValue = ref('')
const renaming = ref(false)
const editDialogOpen = ref(false)
const deleteTarget = ref(null)
const deleting = ref(false)
const reEnrollTarget = ref(null)
const reEnrolling = ref(false)
const reEnrollTitle = computed(() => (reEnrollTarget.value ? `Daftarkan ulang device "${reEnrollTarget.value.device_name}"?` : ''))
const deleteTitle = computed(() => (deleteTarget.value ? `Hapus device "${deleteTarget.value.device_name}" dari sistem?` : ''))

dayjs.extend(relativeTime)

const STATUS_FILTERS = [
    { value: 'all', label: 'Semua' },
    { value: 'online', label: 'Online' },
    { value: 'locked', label: 'Terkunci' },
    { value: 'offline', label: 'Offline' },
    { value: 'pending_enrollment', label: 'Menunggu daftar' },
]
const statusFilter = ref('all')
const search = ref('')

const countByStatus = computed(() =>
    devices.value.reduce((counts, device) => ({ ...counts, [device.status]: (counts[device.status] ?? 0) + 1 }), {}),
)

const visibleDevices = computed(() => {
    const query = search.value.trim().toLowerCase()
    return devices.value.filter(
        (device) =>
            (statusFilter.value === 'all' || device.status === statusFilter.value) &&
            (!query || device.device_name.toLowerCase().includes(query) || (device.organization_name ?? '').toLowerCase().includes(query)),
    )
})

function batteryColor(level) {
    if (level == null) return 'bg-base-700'
    if (level < 20) return 'bg-danger-400'
    if (level < 50) return 'bg-warning-400'
    return 'bg-accent-400'
}

function menuItems(device) {
    const busy = actingDeviceId.value === device.id
    return [
        { label: 'Minta lokasi sekarang', icon: MapPin, onSelect: () => issueCommand(device, 'locate_now'), disabled: busy },
        { label: 'Mulai pantau', icon: PlayCircle, onSelect: () => issueCommand(device, 'start_monitor'), disabled: busy },
        { label: 'Hentikan pantau', icon: StopCircle, onSelect: () => issueCommand(device, 'stop_monitor'), disabled: busy },
        { label: 'Buat OTP buka kunci', icon: KeyRound, onSelect: () => generateOtp(device), disabled: busy },
        { label: 'Ubah nama', icon: Pencil, onSelect: () => openRename(device) },
        { label: 'Daftar ulang', icon: RefreshCw, onSelect: () => (reEnrollTarget.value = device), disabled: device.status === 'locked' },
        { label: 'Hapus device', icon: Trash2, onSelect: () => (deleteTarget.value = device), danger: true },
    ]
}

async function loadDevices() {
    loading.value = true
    try {
        const response = await api.get('/devices', { params: { per_page: 100 } })
        devices.value = response.data.data.items
    } catch {
        toast.error('Gagal memuat device')
    } finally {
        loading.value = false
    }
}

async function issueCommand(device, commandType, reasonNote = null) {
    actingDeviceId.value = device.id
    try {
        await api.post(`/devices/${device.id}/commands`, {
            command_type: commandType,
            issued_via: 'web_dashboard',
            reason_note: reasonNote,
        })
        toast.success('Perintah terkirim', `${commandType} untuk ${device.device_name}`)
        await loadDevices()
    } catch (err) {
        toast.error('Gagal mengirim perintah', err.response?.data?.message)
    } finally {
        actingDeviceId.value = null
    }
}

async function generateOtp(device) {
    actingDeviceId.value = device.id
    try {
        const response = await api.post(`/devices/${device.id}/otp`)
        otpResult.value = { device, ...response.data.data }
    } catch (err) {
        toast.error('Gagal membuat OTP', err.response?.data?.message)
    } finally {
        actingDeviceId.value = null
    }
}

async function confirmDelete() {
    deleting.value = true
    try {
        await api.delete(`/devices/${deleteTarget.value.id}`)
        toast.success('Device dihapus')
        deleteTarget.value = null
        await loadDevices()
    } catch (err) {
        toast.error('Gagal menghapus device', err.response?.data?.message)
    } finally {
        deleting.value = false
    }
}

async function confirmReEnroll() {
    reEnrolling.value = true
    try {
        await api.post(`/devices/${reEnrollTarget.value.id}/re-enroll`)
        toast.success('Device siap didaftarkan ulang', 'Buka aplikasi pelacak di HP tersebut agar terhubung kembali.')
        reEnrollTarget.value = null
        await loadDevices()
    } catch (err) {
        toast.error('Gagal mendaftarkan ulang device', err.response?.data?.message)
    } finally {
        reEnrolling.value = false
    }
}

function openRename(device) {
    renameTarget.value = device
    renameValue.value = device.device_name
    editDialogOpen.value = true
}

async function saveRename() {
    if (!renameTarget.value) return
    const trimmed = renameValue.value.trim()
    if (!trimmed) {
        toast.error('Nama tidak boleh kosong')
        return
    }
    renaming.value = true
    try {
        await api.put(`/devices/${renameTarget.value.id}`, { device_name: trimmed })
        toast.success('Nama device diubah', trimmed)
        editDialogOpen.value = false
        await loadDevices()
    } catch (err) {
        toast.error('Gagal mengganti nama device', err.response?.data?.message)
    } finally {
        renaming.value = false
    }
}

onMounted(loadDevices)
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Perangkat"
            title="Device"
            subtitle="Perangkat yang dipantau di setiap site. Kunci, buka, atau minta lokasi langsung dari sini."
        >
            <template v-if="!loading" #readouts>
                <Readout label="Total" :value="devices.length" />
                <Readout label="Online" :value="countByStatus.online ?? 0" led="accent" />
                <Readout label="Terkunci" :value="countByStatus.locked ?? 0" :led="countByStatus.locked ? 'danger' : 'muted'" />
                <Readout
                    label="Menunggu daftar"
                    :value="countByStatus.pending_enrollment ?? 0"
                    :led="countByStatus.pending_enrollment ? 'warning' : 'muted'"
                />
            </template>
        </PageHeader>

        <div class="p-4 sm:p-8">
            <BaseCard flush>
                <div class="flex flex-wrap items-center justify-between gap-3 border-b border-base-800 px-4 py-3 sm:px-5">
                    <div class="flex flex-wrap gap-1" role="group" aria-label="Saring menurut status">
                        <button
                            v-for="filter in STATUS_FILTERS"
                            :key="filter.value"
                            type="button"
                            :aria-pressed="statusFilter === filter.value"
                            class="rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent-400"
                            :class="statusFilter === filter.value ? 'bg-base-800 text-base-50' : 'text-base-400 hover:text-base-100'"
                            @click="statusFilter = filter.value"
                        >
                            {{ filter.label }}
                            <span class="ml-1 font-mono text-base-500">{{
                                filter.value === 'all' ? devices.length : (countByStatus[filter.value] ?? 0)
                            }}</span>
                        </button>
                    </div>
                    <label class="relative w-full sm:w-64">
                        <span class="sr-only">Cari device</span>
                        <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                        <input v-model="search" type="search" placeholder="Cari nama device atau site" class="field-control !py-2 pl-9" />
                    </label>
                </div>

                <div v-if="loading" class="px-5 py-12 text-center text-sm text-base-500">Memuat device…</div>
                <EmptyState
                    v-else-if="devices.length === 0"
                    :icon="Smartphone"
                    title="Belum ada device terdaftar"
                    description="Device muncul di sini setelah APK pelacak dibuat di menu Build APK lalu dipasang di HP tujuan."
                >
                    <BaseButton variant="outline" @click="$router.push({ name: 'apk-builds' })">Buka Build APK</BaseButton>
                </EmptyState>
                <EmptyState
                    v-else-if="visibleDevices.length === 0"
                    :icon="Search"
                    title="Tidak ada device yang cocok"
                    description="Ubah kata pencarian atau pilih status lain."
                >
                    <BaseButton variant="ghost" @click="((statusFilter = 'all'), (search = ''))">Tampilkan semua</BaseButton>
                </EmptyState>
                <div v-else class="overflow-x-auto">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Device</th>
                                <th class="hidden lg:table-cell">Site</th>
                                <th class="hidden sm:table-cell">Status</th>
                                <th class="hidden sm:table-cell">Baterai</th>
                                <th class="hidden md:table-cell">Terakhir terlihat</th>
                                <th class="w-0"><span class="sr-only">Aksi</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="d in visibleDevices" :key="d.id">
                                <td>
                                    <p class="font-medium text-base-50">{{ d.device_name }}</p>
                                    <p class="font-mono text-[11px] text-base-500" :title="d.device_uuid">
                                        {{ d.device_uuid?.slice(0, 8) }}
                                    </p>
                                    <div class="mt-1.5 sm:hidden"><StatusDot :status="d.status" /></div>
                                </td>
                                <td class="hidden text-base-300 lg:table-cell">{{ d.organization_name ?? '—' }}</td>
                                <td class="hidden sm:table-cell"><StatusDot :status="d.status" /></td>
                                <td class="hidden sm:table-cell">
                                    <div v-if="d.battery_level != null" class="flex items-center gap-2.5">
                                        <span class="h-1.5 w-14 overflow-hidden rounded-full bg-base-800">
                                            <span
                                                class="block h-full rounded-full"
                                                :class="batteryColor(d.battery_level)"
                                                :style="{ width: `${d.battery_level}%` }"
                                            />
                                        </span>
                                        <span class="font-mono text-xs text-base-300 tabular-nums">{{ d.battery_level }}%</span>
                                    </div>
                                    <span v-else class="text-base-600">—</span>
                                </td>
                                <td class="hidden text-xs text-base-400 md:table-cell">
                                    <span v-if="d.last_seen_at" :title="dayjs(d.last_seen_at).format('DD MMM YYYY HH:mm')">{{
                                        dayjs(d.last_seen_at).fromNow()
                                    }}</span>
                                    <span v-else class="text-base-600">Belum pernah</span>
                                </td>
                                <td>
                                    <div class="flex items-center justify-end gap-1">
                                        <BaseButton
                                            v-if="d.status === 'locked'"
                                            size="sm"
                                            variant="outline"
                                            :loading="actingDeviceId === d.id"
                                            @click="issueCommand(d, 'unlock')"
                                        >
                                            <Unlock class="size-3.5" /> <span class="max-sm:sr-only">Buka kunci</span>
                                        </BaseButton>
                                        <BaseButton
                                            v-else
                                            size="sm"
                                            variant="danger-outline"
                                            :loading="actingDeviceId === d.id"
                                            :disabled="d.status === 'pending_enrollment'"
                                            @click="issueCommand(d, 'lock', 'Dikunci manual dari dashboard')"
                                        >
                                            <Lock class="size-3.5" /> <span class="max-sm:sr-only">Kunci</span>
                                        </BaseButton>
                                        <RowMenu :items="menuItems(d)" :label="`Aksi lain untuk ${d.device_name}`" />
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </BaseCard>
        </div>

        <BaseDialog
            :open="editDialogOpen"
            title="Ubah nama device"
            :description="renameTarget?.device_name"
            size="sm"
            @update:open="(v) => (editDialogOpen = v)"
        >
            <form id="rename-form" @submit.prevent="saveRename">
                <BaseInput v-model="renameValue" label="Nama baru" placeholder="Contoh: HP CS Line — Asep" required />
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="editDialogOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="rename-form" :loading="renaming">Simpan nama</BaseButton>
            </template>
        </BaseDialog>

        <BaseDialog
            :open="!!otpResult"
            :title="`OTP buka kunci ${otpResult?.device.device_name ?? ''}`"
            description="Sampaikan kode ini langsung ke pemegang device, jangan lewat chat yang tersimpan."
            size="sm"
            @update:open="(v) => !v && (otpResult = null)"
        >
            <div v-if="otpResult" class="rounded-lg border border-base-700 bg-base-950 py-6 text-center">
                <p class="font-mono text-4xl font-medium tracking-[0.3em] text-accent-300 tabular-nums">{{ otpResult.code }}</p>
                <p class="eyebrow mt-3">Berlaku sampai {{ dayjs(otpResult.expires_at).format('HH:mm:ss') }}</p>
            </div>
            <template #footer>
                <BaseButton variant="outline" @click="otpResult = null">Tutup</BaseButton>
            </template>
        </BaseDialog>

        <ConfirmDialog
            :open="!!reEnrollTarget"
            :title="reEnrollTitle"
            description="Kunci akses lama device ini dicabut. Aplikasi pelacak di HP tersebut mengambil kunci baru otomatis saat terhubung."
            confirm-label="Daftar ulang"
            confirm-variant="primary"
            :loading="reEnrolling"
            @update:open="(v) => !v && (reEnrollTarget = null)"
            @confirm="confirmReEnroll"
        />

        <ConfirmDialog
            :open="!!deleteTarget"
            :title="deleteTitle"
            description="Riwayat lokasi device ini ikut terhapus."
            confirm-label="Hapus device"
            :loading="deleting"
            @update:open="(v) => !v && (deleteTarget = null)"
            @confirm="confirmDelete"
        />
    </div>
</template>
