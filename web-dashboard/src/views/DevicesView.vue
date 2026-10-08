<script setup>
import { KeyRound, Lock, MapPin, Pencil, PlayCircle, StopCircle, Trash2, Unlock } from '@lucide/vue'
import dayjs from 'dayjs'
import { onMounted, ref } from 'vue'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
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

const statusVariant = { online: 'success', offline: 'neutral', locked: 'danger', pending_enrollment: 'warning' }

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

async function removeDevice(device) {
    if (!confirm(`Hapus device "${device.device_name}" dari sistem? History lokasi miliknya ikut terhapus.`)) return
    try {
        await api.delete(`/devices/${device.id}`)
        toast.success('Device dihapus')
        await loadDevices()
    } catch (err) {
        toast.error('Gagal menghapus device', err.response?.data?.message)
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
        <PageHeader title="Device" subtitle="Kelola perangkat yang terdaftar dan kirim perintah" />

        <div class="p-8">
            <BaseCard title="Semua Device">
                <div v-if="loading" class="py-12 text-center text-sm text-base-500">Memuat...</div>
                <div v-else-if="devices.length === 0" class="py-12 text-center text-sm text-base-500">Belum ada device terdaftar.</div>

                <div v-else class="overflow-x-auto">
                    <table class="w-full text-left text-sm">
                        <thead>
                            <tr class="border-b border-base-800 text-xs text-base-500">
                                <th class="pb-3 font-medium">Nama Device</th>
                                <th class="pb-3 font-medium">Status</th>
                                <th class="pb-3 font-medium">Baterai</th>
                                <th class="pb-3 font-medium">Terakhir Terlihat</th>
                                <th class="pb-3 font-medium">Aksi</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-base-800/60">
                            <tr v-for="d in devices" :key="d.id">
                                <td class="py-3">
                                    <p class="font-medium text-base-100">{{ d.device_name }}</p>
                                    <p class="text-xs text-base-500">{{ d.device_uuid }}</p>
                                </td>
                                <td class="py-3">
                                    <BaseBadge :variant="statusVariant[d.status] ?? 'neutral'">{{ d.status }}</BaseBadge>
                                </td>
                                <td class="py-3 text-base-300">{{ d.battery_level != null ? `${d.battery_level}%` : '—' }}</td>
                                <td class="py-3 text-base-400">
                                    {{ d.last_seen_at ? dayjs(d.last_seen_at).format('DD MMM YYYY HH:mm') : '—' }}
                                </td>
                                <td class="py-3">
                                    <div class="flex flex-wrap gap-1.5">
                                        <BaseButton
                                            size="sm"
                                            variant="danger"
                                            :disabled="actingDeviceId === d.id"
                                            @click="issueCommand(d, 'lock', 'Dikunci manual dari dashboard')"
                                        >
                                            <Lock class="size-3.5" /> Lock
                                        </BaseButton>
                                        <BaseButton
                                            size="sm"
                                            variant="outline"
                                            :disabled="actingDeviceId === d.id"
                                            @click="issueCommand(d, 'unlock')"
                                        >
                                            <Unlock class="size-3.5" /> Unlock
                                        </BaseButton>
                                        <BaseButton
                                            size="sm"
                                            variant="ghost"
                                            :disabled="actingDeviceId === d.id"
                                            @click="issueCommand(d, 'locate_now')"
                                        >
                                            <MapPin class="size-3.5" /> Lokasi
                                        </BaseButton>
                                        <BaseButton
                                            size="sm"
                                            variant="ghost"
                                            :disabled="actingDeviceId === d.id"
                                            @click="issueCommand(d, 'start_monitor')"
                                        >
                                            <PlayCircle class="size-3.5" /> Mulai Pantau
                                        </BaseButton>
                                        <BaseButton size="sm" variant="ghost" @click="openRename(d)">
                                            <Pencil class="size-3.5" /> Ubah Nama
                                        </BaseButton>
                                        <BaseButton
                                            size="sm"
                                            variant="ghost"
                                            :disabled="actingDeviceId === d.id"
                                            @click="issueCommand(d, 'stop_monitor')"
                                        >
                                            <StopCircle class="size-3.5" /> Stop Pantau
                                        </BaseButton>
                                        <BaseButton size="sm" variant="outline" :disabled="actingDeviceId === d.id" @click="generateOtp(d)">
                                            <KeyRound class="size-3.5" /> Buat OTP
                                        </BaseButton>
                                        <BaseButton size="sm" variant="ghost" @click="removeDevice(d)">
                                            <Trash2 class="size-3.5" /> Hapus
                                        </BaseButton>
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </BaseCard>
        </div>

        <div
            v-if="editDialogOpen"
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
            @click.self="editDialogOpen = false"
        >
            <div class="w-full max-w-sm rounded-2xl border border-base-800 bg-base-900 p-6 shadow-2xl">
                <p class="text-base font-semibold text-base-50">Ubah Nama Device</p>
                <p class="mt-1 text-xs text-base-500">{{ renameTarget?.device_name }}</p>
                <BaseInput v-model="renameValue" class="mt-4" label="Nama baru" placeholder="Contoh: HP CS Line - Asep" />
                <div class="mt-5 flex justify-end gap-3">
                    <BaseButton variant="ghost" @click="editDialogOpen = false">Batal</BaseButton>
                    <BaseButton :loading="renaming" @click="saveRename">Simpan</BaseButton>
                </div>
            </div>
        </div>

        <div
            v-if="otpResult"
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
            @click.self="otpResult = null"
        >
            <div class="w-full max-w-sm rounded-2xl border border-base-800 bg-base-900 p-6 text-center shadow-2xl">
                <p class="text-sm text-base-400">OTP untuk {{ otpResult.device.device_name }}</p>
                <p class="mt-3 font-mono text-4xl font-bold tracking-widest text-accent-400">{{ otpResult.code }}</p>
                <p class="mt-3 text-xs text-base-500">
                    Berlaku sampai {{ dayjs(otpResult.expires_at).format('HH:mm:ss') }} — beri tahu pemegang device ini secara lisan/tatap
                    muka, jangan dikirim lewat chat yang tersimpan permanen.
                </p>
                <BaseButton class="mt-5 w-full" variant="outline" @click="otpResult = null">Tutup</BaseButton>
            </div>
        </div>
    </div>
</template>
