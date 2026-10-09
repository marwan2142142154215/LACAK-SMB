<script setup>
import { Battery, BatteryLow, Lock, LockOpen, Radar as RadarIcon, Wifi, WifiOff } from '@lucide/vue'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useGatewaySocket } from '@/composables/useGatewaySocket'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

dayjs.extend(relativeTime)

const auth = useAuthStore()
const { connect } = useGatewaySocket()
const toast = useToast()

const devices = reactive(new Map())
const violations = ref([])
const loading = ref(true)
const selectedDeviceId = ref(null)
const selectedDevice = computed(() => (selectedDeviceId.value != null ? devices.get(selectedDeviceId.value) : null))

// Peta pakai Leaflet + tile OpenStreetMap, BUKAN iframe embed Google Maps
// (https://maps.google.com/maps?...&output=embed) seperti sebelumnya --
// iframe embed konsumen itu memuat seluruh JS "mfe" (maps frontend
// experience) yang sama dengan situs maps.google.com penuh, termasuk kode
// komunikasi antar-frame/ekstensi yang tidak pernah dapat balasan di dalam
// iframe tersembunyi kita (makanya console selalu penuh "message port
// closed", bukan error yang bisa diperbaiki dari sisi kita). Leaflet
// me-render peta langsung sebagai elemen yang kita kontrol penuh, tanpa
// iframe sama sekali, tanpa API key, dan tanpa noise itu.
const mapEl = ref(null)
let mapInstance = null
let mapMarker = null

function renderMap(device) {
    if (!mapEl.value || device?.latitude == null || device?.longitude == null) return
    const lat = Number(device.latitude)
    const lng = Number(device.longitude)

    if (!mapInstance) {
        mapInstance = L.map(mapEl.value, { attributionControl: true }).setView([lat, lng], 16)
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap contributors',
        }).addTo(mapInstance)
        mapMarker = L.marker([lat, lng]).addTo(mapInstance)
    } else {
        mapInstance.setView([lat, lng], 16)
        mapMarker.setLatLng([lat, lng])
    }
    mapMarker.bindPopup(device.device_name ?? '').openPopup()
    // Container bisa saja baru pertama kali kelihatan (habis v-else muncul) --
    // Leaflet butuh ini supaya ukuran tile dihitung ulang, kalau tidak peta
    // kadang kepotong/abu-abu sebagian sampai window di-resize manual.
    requestAnimationFrame(() => mapInstance?.invalidateSize())
}

watch(selectedDevice, async (device) => {
    if (device?.latitude == null) return
    await nextTick()
    renderMap(device)
})

onBeforeUnmount(() => {
    mapInstance?.remove()
    mapInstance = null
})

const RADAR_MAX_METERS = 200

const devicesForRadar = computed(() => {
    const list = Array.from(devices.values())
    return list.map((d, index) => {
        const angle = (index / Math.max(list.length, 1)) * 2 * Math.PI
        const hasSignal = d.ble_distance_meters != null
        // Device yang belum pernah kirim jarak BLE (baru enroll / belum ada
        // sinyal) SENGAJA ditaruh di cincin terluar, bukan radiusRatio=0 —
        // kalau tidak, semua device tanpa sinyal akan menumpuk persis di
        // titik tengah (anchor dot), jadi kelihatan seperti "tidak ada titik".
        const radiusRatio = hasSignal ? Math.min(d.ble_distance_meters, RADAR_MAX_METERS) / RADAR_MAX_METERS : 0.95
        return {
            ...d,
            hasSignal,
            x: 50 + radiusRatio * 42 * Math.cos(angle),
            y: 50 + radiusRatio * 42 * Math.sin(angle),
        }
    })
})

const statusColor = {
    online: '#2bc4a4',
    offline: '#4b5568',
    locked: '#dc3c30',
    pending_enrollment: '#d89b2c',
}

async function loadInitialDevices() {
    loading.value = true
    try {
        const response = await api.get('/devices', { params: { per_page: 500 } })
        for (const d of response.data.data.items) {
            devices.set(d.id, {
                device_id: d.id,
                device_name: d.device_name,
                status: d.status,
                battery_level: d.battery_level,
                ble_distance_meters: d.latest_location?.ble_distance_meters ?? null,
                latitude: d.latest_location?.latitude ?? null,
                longitude: d.latest_location?.longitude ?? null,
                recorded_at: d.latest_location?.recorded_at ?? null,
            })
        }
        return true
    } catch (err) {
        // Interceptor global (main.js) sudah menangani 401 (hapus sesi +
        // redirect ke login) -- di sini cukup cegah "Uncaught (in promise)"
        // di console dan beri tahu caller supaya tidak lanjut buka koneksi
        // socket pakai sesi yang sudah tidak valid.
        if (err.response?.status !== 401) {
            toast.error('Gagal memuat daftar device', err.response?.data?.message)
        }
        return false
    } finally {
        loading.value = false
    }
}

onMounted(async () => {
    const ok = await loadInitialDevices()
    if (!ok) return

    const organizationId = auth.isSuperAdmin ? null : auth.user?.organization_id
    const socket = connect(organizationId)

    socket.on('radar:update', (payload) => {
        // SENGAJA menimpa device_id dari payload dengan versi number-nya --
        // gateway (Lucid/node-postgres) bisa mengirim bigint sebagai string,
        // beda dengan REST backend-api (Laravel) yang selalu number. Kalau
        // field device_id di value object ikut jadi string, klik kartu device
        // menyimpan id string ke selectedDeviceId sementara key Map ini tetap
        // number -- devices.get() gagal nemu, peta tidak pernah tampil sampai
        // reload (device_id object itu kebetulan ketimpa ulang jadi number).
        const id = Number(payload.device_id)
        const existing = devices.get(id) ?? {}
        devices.set(id, { ...existing, ...payload, device_id: id })
    })

    socket.on('device:status', (payload) => {
        const id = Number(payload.device_id)
        const existing = devices.get(id) ?? {}
        devices.set(id, { ...existing, ...payload, device_id: id })
    })

    socket.on('violation:alert', (payload) => {
        violations.value.unshift({ ...payload, id: Date.now() })
        violations.value = violations.value.slice(0, 8)
    })
})
</script>

<template>
    <div>
        <PageHeader title="Radar Pemantauan" subtitle="Posisi & status device secara realtime" />

        <div class="grid grid-cols-1 gap-6 p-8 xl:grid-cols-3">
            <BaseCard title="Radar" class="xl:col-span-2">
                <div class="relative mx-auto aspect-square w-full max-w-lg">
                    <svg viewBox="0 0 100 100" class="size-full">
                        <circle
                            v-for="r in [10, 20, 30, 42]"
                            :key="r"
                            cx="50"
                            cy="50"
                            :r="r"
                            fill="none"
                            stroke="#222a37"
                            stroke-width="0.3"
                        />
                        <line x1="50" y1="8" x2="50" y2="92" stroke="#222a37" stroke-width="0.3" />
                        <line x1="8" y1="50" x2="92" y2="50" stroke="#222a37" stroke-width="0.3" />
                        <circle cx="50" cy="50" r="2" fill="#2bc4a4" />

                        <g v-for="d in devicesForRadar" :key="d.device_id">
                            <circle
                                :cx="d.x"
                                :cy="d.y"
                                r="2.2"
                                :fill="d.hasSignal ? (statusColor[d.status] ?? '#4b5568') : 'transparent'"
                                :stroke="statusColor[d.status] ?? '#4b5568'"
                                :stroke-width="d.hasSignal ? 0 : 0.6"
                                :stroke-dasharray="d.hasSignal ? undefined : '1,1'"
                            >
                                <title>{{ d.device_name }}{{ d.hasSignal ? '' : ' (belum ada sinyal BLE)' }}</title>
                            </circle>
                        </g>
                    </svg>
                    <RadarIcon v-if="devices.size === 0 && !loading" class="absolute inset-0 m-auto size-10 text-base-700" />
                </div>
                <p class="mt-3 text-center text-xs text-base-500">
                    Posisi relatif berdasar estimasi jarak BLE (maks {{ RADAR_MAX_METERS }}m dari anchor)
                </p>
            </BaseCard>

            <BaseCard title="Pelanggaran Terbaru">
                <p v-if="violations.length === 0" class="text-sm text-base-500">Belum ada pelanggaran terdeteksi.</p>
                <ul class="space-y-3">
                    <li v-for="v in violations" :key="v.id" class="rounded-lg border border-danger-500/20 bg-danger-500/5 p-3">
                        <p class="text-sm font-medium text-base-100">{{ v.device_name }}</p>
                        <p class="mt-0.5 text-xs text-base-400">{{ v.violation_type }} — {{ v.detected_value }}</p>
                        <p class="mt-1 text-[11px] text-base-600">{{ dayjs(v.detected_at).fromNow() }}</p>
                    </li>
                </ul>
            </BaseCard>

            <BaseCard title="Daftar Device" class="xl:col-span-3">
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div
                        v-for="d in Array.from(devices.values())"
                        :key="d.device_id"
                        class="cursor-pointer rounded-xl border border-base-800 bg-base-850/60 p-4 transition-all hover:border-accent-500/50"
                        :class="{ 'border-accent-500/80': selectedDeviceId === d.device_id }"
                        @click="selectedDeviceId = d.device_id"
                    >
                        <div class="flex items-start justify-between">
                            <p class="text-sm font-medium text-base-100">{{ d.device_name }}</p>
                            <BaseBadge :variant="d.status === 'online' ? 'success' : d.status === 'locked' ? 'danger' : 'neutral'">
                                <Lock v-if="d.status === 'locked'" class="size-3" />
                                <LockOpen v-else class="size-3" />
                                {{ d.status }}
                            </BaseBadge>
                        </div>
                        <div class="mt-3 flex items-center gap-4 text-xs text-base-500">
                            <span class="flex items-center gap-1">
                                <Wifi v-if="d.status === 'online'" class="size-3.5" />
                                <WifiOff v-else class="size-3.5" />
                                {{ d.ble_distance_meters != null ? `${d.ble_distance_meters}m` : '—' }}
                            </span>
                            <span class="flex items-center gap-1">
                                <BatteryLow v-if="d.battery_level < 20" class="size-3.5" />
                                <Battery v-else class="size-3.5" />
                                {{ d.battery_level != null ? `${d.battery_level}%` : '—' }}
                            </span>
                        </div>
                    </div>
                </div>
            </BaseCard>

            <BaseCard title="Peta Lokasi" class="xl:col-span-3">
                <p v-if="!selectedDevice" class="py-6 text-center text-sm text-base-500">Klik satu kartu Device di atas untuk melihat lokasi.</p>
                <p v-else-if="selectedDevice.latitude == null" class="py-6 text-center text-sm text-base-500">Device ini belum mengirim koordinat GPS.</p>
                <div v-show="selectedDevice?.latitude != null" ref="mapEl" class="h-96 w-full rounded-xl border border-base-800"></div>
            </BaseCard>
        </div>
    </div>
</template>
