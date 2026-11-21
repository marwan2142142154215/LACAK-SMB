<script setup>
import {
    AlertTriangle,
    ArrowLeft,
    BatteryCharging,
    Check,
    KeyRound,
    Lock,
    MapPin,
    Minus,
    PlayCircle,
    RefreshCw,
    StopCircle,
    Unlock,
    Unplug,
} from '@lucide/vue'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import StatusDot from '@/components/ui/StatusDot.vue'
import { useGatewaySocket } from '@/composables/useGatewaySocket'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import {
    COMMAND_TYPE_LABELS,
    PERMISSION_LABELS,
    commandStatusMeta,
    isLocationServiceOff,
    isStorageLow,
    locationQualityLabel,
    managementModeLabel,
    missingPermissions,
    modelLabel,
    networkLabel,
    policyLockRows,
    storageLabel,
} from '@/lib/deviceInfo'
import { useAuthStore } from '@/stores/auth'

dayjs.extend(relativeTime)

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const toast = useToast()
const allowed = (permission) => auth.hasPermission(permission)
const canSeeLocation = computed(() => allowed('radar.view'))

const deviceId = computed(() => Number(route.params.id))
const device = ref(null)
const loading = ref(true)
const notFound = ref(false)
const commands = ref([])
const loadingCommands = ref(false)
const acting = ref(false)

// Dialog aksi.
const otpResult = ref(null)
const releaseResult = ref(null)
const renameOpen = ref(false)
const renameValue = ref('')
const renaming = ref(false)

const missing = computed(() => missingPermissions(device.value?.permission_state))
const location = computed(() => device.value?.latest_location ?? null)
const managementLabel = computed(() => managementModeLabel(device.value?.permission_state))
const lockRows = computed(() => policyLockRows(device.value))
const locationOff = computed(() => isLocationServiceOff(device.value))
// Kartu "Kontrol perusahaan" hanya berguna kalau HP memang dikelola atau pernah melaporkan statusnya.
const showManagementCard = computed(
    () =>
        !!managementLabel.value ||
        device.value?.location_policy_locked != null ||
        device.value?.uninstall_locked != null ||
        !!device.value?.released_at
)

// Baris izin lengkap (semua yang pernah dilaporkan HP), untuk kartu Izin.
const permissionRows = computed(() => {
    const state = device.value?.permission_state
    if (!state) return []
    const owner = state.deviceOwner === true
    return Object.keys(PERMISSION_LABELS)
        .filter((key) => key in state)
        .map((key) => ({
            label: PERMISSION_LABELS[key],
            granted: state[key] === true || (owner && (key === 'deviceAdmin' || key === 'overlay')),
            optional: key === 'bluetooth',
        }))
})

const detailRows = computed(() => {
    const d = device.value
    if (!d) return []
    return [
        ['Perangkat', modelLabel(d)],
        ['Android', d.android_version || null],
        ['Versi aplikasi', d.app_build_version ? `${d.app_build_version}${d.app_version_code ? ` (${d.app_version_code})` : ''}` : null],
        ['Baterai', d.battery_level != null ? `${d.battery_level}%${d.is_charging ? ' · sedang dicas' : ''}` : null],
        ['Jaringan', networkLabel(d)],
        ['Penyimpanan', storageLabel(d)],
        ['Site', d.organization_name],
        ['ID Device', d.device_uuid],
        ['Terdaftar', d.enrolled_at ? dayjs(d.enrolled_at).format('DD MMM YYYY HH:mm') : null],
        ['Terakhir terlihat', d.last_seen_at ? `${dayjs(d.last_seen_at).fromNow()} · ${dayjs(d.last_seen_at).format('DD MMM YYYY HH:mm')}` : null],
        ['Detail diperbarui', d.info_updated_at ? dayjs(d.info_updated_at).fromNow() : null],
    ]
})

async function loadDevice(withSpinner = true) {
    if (withSpinner) loading.value = true
    try {
        const response = await api.get(`/devices/${deviceId.value}`)
        device.value = response.data.data
        notFound.value = false
    } catch (err) {
        if (err.response?.status === 404) notFound.value = true
        else toast.error('Gagal memuat perangkat', err.response?.data?.message)
    } finally {
        loading.value = false
    }
}

async function loadCommands() {
    loadingCommands.value = true
    try {
        const response = await api.get(`/devices/${deviceId.value}/commands`, { params: { per_page: 20 } })
        commands.value = response.data.data.items
    } catch {
        // Gagal memuat riwayat tidak menghalangi detail perangkat ditampilkan.
        commands.value = []
    } finally {
        loadingCommands.value = false
    }
}

async function issueCommand(commandType, reasonNote = null) {
    acting.value = true
    try {
        const response = await api.post(`/devices/${deviceId.value}/commands`, {
            command_type: commandType,
            issued_via: 'web_dashboard',
            reason_note: reasonNote,
        })
        toast.success(COMMAND_TYPE_LABELS[commandType] ?? commandType, response.data?.message ?? 'Perintah terkirim')
        await Promise.all([loadDevice(false), loadCommands()])
    } catch (err) {
        toast.error('Gagal mengirim perintah', err.response?.data?.message)
    } finally {
        acting.value = false
    }
}

async function generateOtp() {
    acting.value = true
    try {
        const response = await api.post(`/devices/${deviceId.value}/otp`)
        otpResult.value = response.data.data
    } catch (err) {
        toast.error('Gagal membuat OTP', err.response?.data?.message)
    } finally {
        acting.value = false
    }
}

async function generateReleaseCode() {
    acting.value = true
    try {
        const response = await api.post(`/devices/${deviceId.value}/otp`, { purpose: 'release' })
        releaseResult.value = response.data.data
    } catch (err) {
        toast.error('Gagal membuat kode lepas', err.response?.data?.message)
    } finally {
        acting.value = false
    }
}

function openRename() {
    renameValue.value = device.value?.device_name ?? ''
    renameOpen.value = true
}

async function saveRename() {
    const trimmed = renameValue.value.trim()
    if (!trimmed) {
        toast.error('Nama tidak boleh kosong')
        return
    }
    renaming.value = true
    try {
        await api.put(`/devices/${deviceId.value}`, { device_name: trimmed })
        toast.success('Nama device diubah', trimmed)
        renameOpen.value = false
        await loadDevice(false)
    } catch (err) {
        toast.error('Gagal mengganti nama device', err.response?.data?.message)
    } finally {
        renaming.value = false
    }
}

// ---- Pagar lokasi per-HP: keluar radius -> auto-lock (lihat GeofenceEvaluator gateway) ----
const fenceLat = ref('')
const fenceLng = ref('')
const fenceRadius = ref('')
const savingFence = ref(false)
const hasFence = computed(() => device.value?.geofence_latitude != null)

watch(
    device,
    (d) => {
        fenceLat.value = d?.geofence_latitude ?? ''
        fenceLng.value = d?.geofence_longitude ?? ''
        fenceRadius.value = d?.geofence_radius_meters ?? ''
    },
    { immediate: true },
)

function fenceFromLastLocation() {
    const loc = device.value?.latest_location
    if (loc?.latitude == null) {
        toast.error('Belum ada lokasi terakhir HP ini')
        return
    }
    fenceLat.value = loc.latitude
    fenceLng.value = loc.longitude
    if (!fenceRadius.value) fenceRadius.value = 100
}

async function saveFence() {
    const lat = Number(fenceLat.value)
    const lng = Number(fenceLng.value)
    const radius = Number(fenceRadius.value)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius) || radius <= 0) {
        toast.error('Isi latitude, longitude, dan radius (meter) yang benar')
        return
    }
    savingFence.value = true
    try {
        await api.put(`/devices/${deviceId.value}/geofence`, {
            latitude: lat,
            longitude: lng,
            radius_meters: Math.round(radius),
        })
        toast.success('Pagar lokasi dipasang', `Radius ${Math.round(radius)} m — HP terkunci otomatis jika keluar`)
        await loadDevice(false)
    } catch (err) {
        toast.error('Gagal memasang pagar lokasi', err.response?.data?.message)
    } finally {
        savingFence.value = false
    }
}

async function clearFence() {
    savingFence.value = true
    try {
        await api.put(`/devices/${deviceId.value}/geofence`, { latitude: null, longitude: null, radius_meters: null })
        toast.success('Pagar lokasi dihapus')
        await loadDevice(false)
    } catch (err) {
        toast.error('Gagal menghapus pagar lokasi', err.response?.data?.message)
    } finally {
        savingFence.value = false
    }
}

const menuItems = computed(() => [
    { label: 'Minta lokasi sekarang', icon: MapPin, onSelect: () => issueCommand('locate_now'), disabled: acting.value, hidden: !allowed('devices.locate') },
    { label: 'Mulai pantau', icon: PlayCircle, onSelect: () => issueCommand('start_monitor'), disabled: acting.value, hidden: !allowed('devices.monitor') },
    { label: 'Hentikan pantau', icon: StopCircle, onSelect: () => issueCommand('stop_monitor'), disabled: acting.value, hidden: !allowed('devices.monitor') },
    { label: 'Buat OTP buka kunci', icon: KeyRound, onSelect: generateOtp, disabled: acting.value, hidden: !allowed('devices.unlock') },
    { label: 'Buat kode lepas perangkat', icon: Unplug, onSelect: generateReleaseCode, disabled: acting.value, hidden: !allowed('devices.manage') },
    { label: 'Ubah nama', icon: RefreshCw, onSelect: openRename, hidden: !allowed('devices.manage') },
])

// ---- Peta lokasi (Leaflet), sama gaya dengan Radar ----
const mapEl = ref(null)
let mapInstance = null
let mapMarker = null
let accuracyCircle = null

const deviceIcon = L.divIcon({
    className: 'device-pin',
    html: '<span class="device-pin-dot"></span>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
})

function renderMap(loc) {
    if (!mapEl.value || loc?.latitude == null || loc?.longitude == null) return
    const lat = Number(loc.latitude)
    const lng = Number(loc.longitude)
    if (!mapInstance) {
        mapInstance = L.map(mapEl.value, { attributionControl: true }).setView([lat, lng], 16)
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap contributors',
        }).addTo(mapInstance)
        mapMarker = L.marker([lat, lng], { icon: deviceIcon }).addTo(mapInstance)
    } else {
        mapInstance.setView([lat, lng], 16)
        mapMarker.setLatLng([lat, lng])
    }
    const accuracy = Number(loc.accuracy_meters)
    if (loc.accuracy_meters != null && Number.isFinite(accuracy) && accuracy > 0) {
        if (!accuracyCircle) {
            accuracyCircle = L.circle([lat, lng], { radius: accuracy, color: '#f59e0b', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(mapInstance)
        } else {
            accuracyCircle.setLatLng([lat, lng]).setRadius(accuracy)
        }
    } else if (accuracyCircle) {
        accuracyCircle.remove()
        accuracyCircle = null
    }
    requestAnimationFrame(() => mapInstance?.invalidateSize())
}

watch(location, async (loc) => {
    if (loc?.latitude == null) return
    await nextTick()
    renderMap(loc)
})

// ---- Update langsung dari gateway ----
const { connect } = useGatewaySocket()

function patchCommandList(payload) {
    const id = Number(payload.command_id)
    const index = commands.value.findIndex((c) => Number(c.id) === id)
    if (index !== -1) {
        commands.value[index] = { ...commands.value[index], status: payload.status, result_message: payload.result_message ?? commands.value[index].result_message }
    } else {
        // Perintah baru yang belum ada di daftar (mis. dikeluarkan dari device lain): muat ulang.
        loadCommands()
    }
}

function listenGateway() {
    const socket = connect(auth.isSuperAdmin ? null : auth.user?.organization_id)
    socket.on('device:status', (payload) => {
        if (Number(payload.device_id) !== deviceId.value || !device.value) return
        const { device_id: _id, device_name: _name, ...changes } = payload
        device.value = { ...device.value, ...changes }
    })
    socket.on('device:command', (payload) => {
        if (Number(payload.device_id) !== deviceId.value || !device.value) return
        const current = device.value.latest_command
        const commandId = Number(payload.command_id)
        if (!current || Number(current.id) <= commandId) {
            device.value = {
                ...device.value,
                latest_command: {
                    ...(current && Number(current.id) === commandId ? current : {}),
                    id: commandId,
                    command_type: payload.command_type,
                    status: payload.status,
                    result_message: payload.result_message ?? current?.result_message ?? null,
                },
            }
        }
        patchCommandList(payload)
        if (payload.status === 'failed') {
            toast.error(`${COMMAND_TYPE_LABELS[payload.command_type] ?? payload.command_type} gagal`, payload.result_message)
        }
    })
    socket.on('radar:update', (payload) => {
        if (Number(payload.device_id) !== deviceId.value || !device.value) return
        if (payload.latitude == null) return
        device.value = {
            ...device.value,
            latest_location: {
                ...(device.value.latest_location ?? {}),
                latitude: payload.latitude,
                longitude: payload.longitude,
                accuracy_meters: payload.accuracy_meters ?? null,
                location_provider: payload.location_provider ?? null,
                fixed_at: payload.fixed_at ?? null,
                recorded_at: payload.recorded_at ?? null,
            },
        }
    })
}

// Pindah antar-perangkat tanpa keluar halaman (mis. dari tautan): muat ulang.
watch(deviceId, () => {
    device.value = null
    commands.value = []
    loadDevice()
    loadCommands()
})

onMounted(() => {
    loadDevice()
    loadCommands()
    listenGateway()
})

onBeforeUnmount(() => {
    mapInstance?.remove()
    mapInstance = null
    accuracyCircle = null
})
</script>

<template>
    <div>
        <PageHeader eyebrow="Perangkat" :title="device?.device_name ?? 'Detail perangkat'" :subtitle="device?.device_uuid">
            <template v-if="device" #actions>
                <BaseButton
                    v-if="device.status === 'locked' && allowed('devices.unlock')"
                    variant="outline"
                    :loading="acting"
                    @click="issueCommand('unlock')"
                >
                    <Unlock class="size-4" /> Buka kunci
                </BaseButton>
                <BaseButton
                    v-else-if="device.status !== 'locked' && allowed('devices.lock')"
                    variant="danger-outline"
                    :loading="acting"
                    :disabled="device.status === 'pending_enrollment'"
                    @click="issueCommand('lock', 'Dikunci manual dari dashboard')"
                >
                    <Lock class="size-4" /> Kunci
                </BaseButton>
                <RowMenu v-if="menuItems.some((item) => !item.hidden)" :items="menuItems" label="Aksi lain untuk perangkat ini" />
            </template>
        </PageHeader>

        <div class="p-4 sm:p-8">
            <RouterLink :to="{ name: 'devices' }" class="mb-5 inline-flex items-center gap-1.5 text-sm text-base-400 transition-colors hover:text-base-100">
                <ArrowLeft class="size-4" /> Kembali ke daftar device
            </RouterLink>

            <div v-if="loading" class="py-16 text-center text-sm text-base-500">Memuat perangkat…</div>
            <EmptyState
                v-else-if="notFound"
                :icon="AlertTriangle"
                title="Perangkat tidak ditemukan"
                description="Perangkat ini mungkin sudah dihapus."
            >
                <BaseButton variant="outline" @click="router.push({ name: 'devices' })">Ke daftar device</BaseButton>
            </EmptyState>

            <div v-else-if="device" class="space-y-6">
                <div class="flex flex-wrap items-center gap-3">
                    <StatusDot :status="device.status" />
                    <span v-if="device.is_charging" class="inline-flex items-center gap-1 text-xs text-accent-300">
                        <BatteryCharging class="size-3.5" /> Mengisi daya
                    </span>
                    <span v-if="device.battery_level != null" class="text-xs text-base-400">Baterai {{ device.battery_level }}%</span>
                </div>

                <div
                    v-if="missing && missing.length"
                    class="flex gap-2.5 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3.5 text-sm text-warning-300"
                    role="status"
                >
                    <AlertTriangle class="mt-0.5 size-4 shrink-0" />
                    <div>
                        <p class="font-semibold">Izin di HP belum lengkap — pelacakan/kunci bisa tidak andal</p>
                        <p class="mt-1 text-pretty">{{ missing.join(', ') }}. Minta pemegang HP membuka aplikasi SMB Pelacak lalu tekan "Lanjutkan penyiapan".</p>
                    </div>
                </div>

                <div
                    v-if="locationOff"
                    class="flex gap-2.5 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3.5 text-sm text-warning-300"
                    role="status"
                >
                    <AlertTriangle class="mt-0.5 size-4 shrink-0" />
                    <div>
                        <p class="font-semibold">Lokasi/GPS HP sedang dimatikan</p>
                        <p class="mt-1 text-pretty">Posisi tidak akan terkirim sampai GPS dinyalakan lagi. HP ini bukan Device Owner, jadi lokasi belum terkunci menyala — minta staf menyalakan GPS.</p>
                    </div>
                </div>

                <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
                    <div class="space-y-6">
                        <BaseCard title="Detail perangkat">
                            <dl class="grid grid-cols-1 gap-x-6 gap-y-3.5 text-sm sm:grid-cols-2">
                                <div v-for="[label, value] in detailRows" :key="label" class="min-w-0">
                                    <dt class="eyebrow">{{ label }}</dt>
                                    <dd
                                        class="mt-0.5 break-words"
                                        :class="[value ? 'text-base-100' : 'text-base-600', label === 'Penyimpanan' && isStorageLow(device) && 'text-warning-400', label === 'ID Device' && 'font-mono text-xs']"
                                    >
                                        {{ value ?? '—' }}
                                    </dd>
                                </div>
                            </dl>
                        </BaseCard>

                        <BaseCard v-if="canSeeLocation" title="Lokasi terakhir" flush>
                            <template v-if="location?.latitude != null">
                                <div class="px-5 pt-4">
                                    <p class="font-mono text-xs text-base-200 tabular-nums">{{ location.latitude }}, {{ location.longitude }}</p>
                                    <p class="mt-1 text-xs text-base-400">
                                        {{ locationQualityLabel(location) ?? 'Akurasi tidak diketahui' }}
                                        · fix {{ dayjs(location.fixed_at ?? location.recorded_at).fromNow() }}
                                        <span v-if="location.fixed_at && dayjs(location.recorded_at).diff(location.fixed_at, 'minute') >= 2" class="text-warning-400">
                                            (GPS belum dapat posisi baru)
                                        </span>
                                    </p>
                                </div>
                                <div ref="mapEl" class="mt-3 map h-[22rem] w-full" />
                            </template>
                            <EmptyState
                                v-else
                                :icon="MapPin"
                                title="Belum ada koordinat GPS"
                                description="Device ini belum pernah mengirim lokasi. Gunakan 'Minta lokasi sekarang'."
                            />
                        </BaseCard>

                        <BaseCard v-if="allowed('devices.manage')" title="Pagar lokasi HP">
                            <p class="text-xs text-pretty text-base-400">
                                Patok HP ini ke satu titik GPS. Jika keluar radius, HP
                                <strong class="text-base-200">terkunci otomatis</strong> dan terbuka lagi saat kembali.
                            </p>
                            <div
                                v-if="hasFence"
                                class="mt-3 rounded-lg border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-xs"
                            >
                                <p class="font-medium text-base-100">Pagar aktif</p>
                                <p class="mt-0.5 font-mono text-base-300 tabular-nums">
                                    {{ device.geofence_latitude }}, {{ device.geofence_longitude }} · radius
                                    {{ device.geofence_radius_meters }} m
                                </p>
                            </div>
                            <div class="mt-4 grid grid-cols-2 gap-3">
                                <label class="block">
                                    <span class="field-label">Latitude</span>
                                    <input v-model="fenceLat" inputmode="decimal" class="field-control" placeholder="-6.1891" />
                                </label>
                                <label class="block">
                                    <span class="field-label">Longitude</span>
                                    <input v-model="fenceLng" inputmode="decimal" class="field-control" placeholder="106.7366" />
                                </label>
                            </div>
                            <label class="mt-3 block">
                                <span class="field-label">Radius (meter)</span>
                                <input v-model="fenceRadius" inputmode="numeric" class="field-control" placeholder="100" />
                            </label>
                            <div class="mt-4 flex flex-wrap gap-2">
                                <BaseButton size="sm" variant="outline" :disabled="savingFence" @click="fenceFromLastLocation">
                                    <MapPin class="size-4" /> Pakai lokasi terakhir
                                </BaseButton>
                                <BaseButton size="sm" :loading="savingFence" @click="saveFence">Simpan pagar</BaseButton>
                                <BaseButton
                                    v-if="hasFence"
                                    size="sm"
                                    variant="danger-outline"
                                    :disabled="savingFence"
                                    @click="clearFence"
                                    >Hapus pagar</BaseButton
                                >
                            </div>
                        </BaseCard>
                    </div>

                    <div class="space-y-6">
                        <BaseCard v-if="showManagementCard" title="Kontrol perusahaan">
                            <dl class="space-y-3 text-sm">
                                <div class="flex items-center justify-between gap-3">
                                    <dt class="text-base-200">Pengelolaan</dt>
                                    <dd class="text-right text-base-100">{{ managementLabel ?? '—' }}</dd>
                                </div>
                                <div v-for="row in lockRows" :key="row.label" class="flex items-center justify-between gap-3">
                                    <dt class="text-base-200">{{ row.label }}</dt>
                                    <dd
                                        class="inline-flex items-center gap-1 text-xs font-medium"
                                        :class="{ 'text-st-online': row.tone === 'ok', 'text-warning-400': row.tone === 'warn', 'text-base-500': row.tone === 'muted' }"
                                    >
                                        <Check v-if="row.tone === 'ok'" class="size-3.5" />
                                        <Minus v-else class="size-3.5" />
                                        {{ row.text }}
                                    </dd>
                                </div>
                                <div v-if="device.released_at" class="flex items-center justify-between gap-3">
                                    <dt class="text-base-200">Dilepas</dt>
                                    <dd class="text-right text-warning-400">{{ dayjs(device.released_at).format('DD MMM YYYY HH:mm') }}</dd>
                                </div>
                            </dl>
                            <div v-if="allowed('devices.manage') && !device.released_at" class="mt-4 border-t border-base-800 pt-4">
                                <p class="text-xs text-pretty text-base-400">
                                    Untuk melepas perangkat (HP dikembalikan/diganti): buat kode lalu berikan ke staf untuk dimasukkan di aplikasi HP — mencabut kunci lokasi &amp; penghapusan lalu melepas aplikasi.
                                </p>
                                <BaseButton class="mt-3" size="sm" variant="outline" :loading="acting" @click="generateReleaseCode">
                                    <Unplug class="size-4" /> Buat kode lepas perangkat
                                </BaseButton>
                            </div>
                        </BaseCard>

                        <BaseCard title="Status izin di HP">
                            <ul v-if="permissionRows.length" class="space-y-2.5 text-sm">
                                <li v-for="row in permissionRows" :key="row.label" class="flex items-center justify-between gap-3">
                                    <span class="text-base-200">{{ row.label }}</span>
                                    <span
                                        class="inline-flex items-center gap-1 text-xs font-medium"
                                        :class="row.granted ? 'text-st-online' : row.optional ? 'text-base-500' : 'text-danger-400'"
                                    >
                                        <Check v-if="row.granted" class="size-3.5" />
                                        <Minus v-else class="size-3.5" />
                                        {{ row.granted ? 'Diberikan' : row.optional ? 'Dilewati' : 'Belum' }}
                                    </span>
                                </li>
                            </ul>
                            <p v-else class="text-sm text-base-500">Status izin belum dilaporkan HP (aplikasi versi lama atau belum pernah terhubung).</p>
                        </BaseCard>

                        <BaseCard flush>
                            <div class="flex items-center justify-between px-5 py-3.5">
                                <h3 class="text-sm font-semibold text-base-100">Riwayat perintah</h3>
                                <BaseButton size="sm" variant="ghost" :loading="loadingCommands" @click="loadCommands">Muat ulang</BaseButton>
                            </div>
                            <p v-if="!loadingCommands && commands.length === 0" class="px-5 pb-4 text-sm text-base-500">Belum ada perintah.</p>
                            <ol v-else class="divide-y divide-base-800/70 border-t border-base-800">
                                <li v-for="c in commands" :key="c.id" class="px-5 py-3">
                                    <div class="flex flex-wrap items-center justify-between gap-2">
                                        <span class="text-sm text-base-100">{{ COMMAND_TYPE_LABELS[c.command_type] ?? c.command_type }}</span>
                                        <BaseBadge :variant="commandStatusMeta(c.status).variant">{{ commandStatusMeta(c.status).label }}</BaseBadge>
                                    </div>
                                    <p v-if="c.result_message" class="mt-1 text-xs text-pretty text-base-300">{{ c.result_message }}</p>
                                    <p class="mt-1 font-mono text-[11px] text-base-500">
                                        {{ dayjs(c.created_at).format('DD MMM HH:mm:ss') }}
                                        <template v-if="c.delivered_at"> · terkirim {{ dayjs(c.delivered_at).format('HH:mm:ss') }}</template>
                                        <template v-if="c.delivery_attempts > 1"> ({{ c.delivery_attempts }}×)</template>
                                        <template v-if="c.executed_at"> · selesai {{ dayjs(c.executed_at).format('HH:mm:ss') }}</template>
                                    </p>
                                </li>
                            </ol>
                        </BaseCard>
                    </div>
                </div>
            </div>
        </div>

        <BaseDialog
            :open="!!otpResult"
            title="OTP buka kunci"
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

        <BaseDialog
            :open="!!releaseResult"
            title="Kode lepas perangkat"
            description="Berikan kode ini langsung ke staf pemegang HP. Masukkan di aplikasi SMB Pelacak → 'Lepas perangkat' untuk mencabut kunci lokasi & penghapusan, lalu hapus aplikasi."
            size="sm"
            @update:open="(v) => !v && (releaseResult = null)"
        >
            <div v-if="releaseResult" class="rounded-lg border border-base-700 bg-base-950 py-6 text-center">
                <p class="font-mono text-4xl font-medium tracking-[0.3em] text-accent-300 tabular-nums">{{ releaseResult.code }}</p>
                <p class="eyebrow mt-3">Berlaku sampai {{ dayjs(releaseResult.expires_at).format('HH:mm:ss') }}</p>
            </div>
            <template #footer>
                <BaseButton variant="outline" @click="releaseResult = null">Tutup</BaseButton>
            </template>
        </BaseDialog>

        <BaseDialog :open="renameOpen" title="Ubah nama device" size="sm" @update:open="(v) => (renameOpen = v)">
            <form id="detail-rename-form" @submit.prevent="saveRename">
                <BaseInput v-model="renameValue" label="Nama baru" placeholder="Contoh: HP CS Line — Asep" required />
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="renameOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="detail-rename-form" :loading="renaming">Simpan nama</BaseButton>
            </template>
        </BaseDialog>
    </div>
</template>

<style scoped>
/* Tile: terang di tema terang, dibalik gelap di tema gelap supaya menyatu panel */
.map :deep(.leaflet-tile-pane) {
    filter: saturate(0.9) brightness(1.02);
}

:global(:root[data-theme='dark']) .map :deep(.leaflet-tile-pane) {
    filter: invert(1) hue-rotate(180deg) brightness(0.82) contrast(0.92) saturate(0.6);
}
.map :deep(.leaflet-container) {
    background-color: var(--color-base-950);
    font-family: var(--font-sans);
}
.map :deep(.device-pin) {
    border: 0;
    background: transparent;
}
.map :deep(.device-pin-dot) {
    display: block;
    width: 22px;
    height: 22px;
    border: 3px solid #fff;
    border-radius: 9999px;
    background: var(--color-accent-500);
    box-shadow:
        0 0 0 6px color-mix(in oklab, var(--color-accent-500) 28%, transparent),
        0 2px 8px rgb(0 0 0 / 0.45);
}
.map :deep(.leaflet-control-attribution) {
    background-color: rgb(5 7 10 / 0.7);
    color: var(--color-base-500);
}
.map :deep(.leaflet-control-attribution a) {
    color: var(--color-base-300);
}
.map :deep(.leaflet-bar) {
    border: 1px solid var(--color-base-700);
    box-shadow: none;
}
.map :deep(.leaflet-bar a) {
    background-color: var(--color-base-850);
    border-bottom-color: var(--color-base-700);
    color: var(--color-base-100);
}
.map :deep(.leaflet-bar a:hover) {
    background-color: var(--color-base-800);
}
</style>
