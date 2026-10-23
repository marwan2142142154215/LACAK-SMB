<script setup>
import { MapPin, Radar as RadarIcon, ShieldAlert } from '@lucide/vue'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import RadarScope from '@/components/radar/RadarScope.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
import StatusDot from '@/components/ui/StatusDot.vue'
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
    // Leaflet menulis popup berupa string lewat innerHTML -- nama device
    // diketik admin site, jadi dikirim sebagai node teks agar tidak bisa
    // menyisipkan skrip (stored XSS ke super_admin yang membuka Radar).
    const popupContent = document.createElement('span')
    popupContent.textContent = device.device_name ?? ''
    mapMarker.bindPopup(popupContent).openPopup()
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

// Urutan daftar: yang perlu perhatian dulu (terkunci), lalu online, lalu sisanya
const STATUS_ORDER = { locked: 0, online: 1, pending_enrollment: 2, offline: 3 }
const deviceList = computed(() =>
    Array.from(devices.values()).sort(
        (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || (a.device_name ?? '').localeCompare(b.device_name ?? ''),
    ),
)

const countByStatus = computed(() => deviceList.value.reduce((counts, d) => ({ ...counts, [d.status]: (counts[d.status] ?? 0) + 1 }), {}))

// Skala radar menyesuaikan device terjauh (kelipatan 50 m, maks 200 m) supaya titik tidak menumpuk di tengah
const scopeMaxMeters = computed(() => {
    const farthest = Math.max(0, ...deviceList.value.map((d) => Number(d.ble_distance_meters) || 0))
    return Math.min(RADAR_MAX_METERS, Math.max(50, Math.ceil(farthest / 50) * 50))
})

const scopeDevices = computed(() =>
    deviceList.value.map((d) => ({
        id: d.device_id,
        label: d.device_name,
        status: d.status,
        distance: d.ble_distance_meters != null ? Number(d.ble_distance_meters) : null,
    })),
)

const VIOLATION_LABELS = {
    wifi_mismatch: 'WiFi di luar daftar',
    ip_mismatch: 'IP di luar daftar',
    distance_exceeded: 'Keluar radius aman',
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
    selectedDeviceId.value = deviceList.value.find((d) => d.latitude != null && d.status === 'online')?.device_id ?? null

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
        <PageHeader
            eyebrow="Pantau"
            title="Radar"
            subtitle="Jarak tiap device dari anchor, diperbarui langsung dari gateway. Pilih titik atau nama device untuk melihat lokasinya di peta."
        >
            <template v-if="!loading" #readouts>
                <Readout label="Dalam jangkauan" :value="scopeDevices.filter((d) => d.distance != null).length" led="accent" />
                <Readout label="Tanpa sinyal BLE" :value="scopeDevices.filter((d) => d.distance == null).length" led="muted" />
                <Readout label="Skala radar" :value="`${scopeMaxMeters} m`" />
                <Readout label="Pelanggaran sesi ini" :value="violations.length" :led="violations.length ? 'danger' : 'muted'" />
            </template>
        </PageHeader>

        <div class="space-y-6 p-4 sm:p-8">
            <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
                <BaseCard title="Radar BLE" subtitle="Anchor di tengah · jarak diperkirakan dari kekuatan sinyal BLE">
                    <div class="mx-auto w-full max-w-[34rem] py-2">
                        <RadarScope
                            :devices="scopeDevices"
                            :selected-id="selectedDeviceId"
                            :max-meters="scopeMaxMeters"
                            @select="(id) => (selectedDeviceId = id)"
                        />
                    </div>
                    <div class="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-base-800 pt-4">
                        <StatusDot status="online" />
                        <StatusDot status="locked" />
                        <StatusDot status="pending_enrollment" />
                        <StatusDot status="offline" />
                        <span class="flex items-center gap-2 text-xs text-base-400">
                            <span class="size-2 rounded-full border border-dashed border-base-400" /> Belum ada sinyal BLE
                        </span>
                    </div>
                </BaseCard>

                <BaseCard title="Device" :count="loading ? null : deviceList.length" flush>
                    <div v-if="loading" class="px-5 py-12 text-center text-sm text-base-500">Memuat device…</div>
                    <EmptyState
                        v-else-if="deviceList.length === 0"
                        :icon="RadarIcon"
                        title="Radar masih kosong"
                        description="Device muncul di sini setelah APK pelacak terpasang dan terhubung."
                    />
                    <ul v-else class="max-h-[36rem] divide-y divide-base-800/70 overflow-y-auto">
                        <li v-for="d in deviceList" :key="d.device_id">
                            <button
                                type="button"
                                class="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-base-850 focus-visible:bg-base-850 focus-visible:outline-none"
                                :class="selectedDeviceId === d.device_id && 'bg-base-850 shadow-[inset_2px_0_0_var(--color-accent-400)]'"
                                :aria-pressed="selectedDeviceId === d.device_id"
                                @click="selectedDeviceId = d.device_id"
                            >
                                <div class="min-w-0 flex-1">
                                    <p class="truncate text-sm font-medium text-base-50">{{ d.device_name }}</p>
                                    <div class="mt-1"><StatusDot :status="d.status" /></div>
                                </div>
                                <div class="shrink-0 text-right font-mono text-xs tabular-nums">
                                    <p class="text-base-100">
                                        {{ d.ble_distance_meters != null ? `${Number(d.ble_distance_meters).toFixed(1)} m` : '—' }}
                                    </p>
                                    <p
                                        class="mt-1"
                                        :class="d.battery_level != null && d.battery_level < 20 ? 'text-danger-400' : 'text-base-500'"
                                    >
                                        {{ d.battery_level != null ? `${d.battery_level}%` : '' }}
                                    </p>
                                </div>
                            </button>
                        </li>
                    </ul>
                </BaseCard>
            </div>

            <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
                <BaseCard
                    :title="selectedDevice ? `Lokasi · ${selectedDevice.device_name}` : 'Lokasi'"
                    :subtitle="selectedDevice?.recorded_at ? `Posisi terakhir ${dayjs(selectedDevice.recorded_at).fromNow()}` : null"
                    flush
                >
                    <EmptyState
                        v-if="!selectedDevice"
                        :icon="MapPin"
                        title="Pilih device"
                        description="Klik titik di radar atau nama device untuk melihat posisinya di peta."
                    />
                    <EmptyState
                        v-else-if="selectedDevice.latitude == null"
                        :icon="MapPin"
                        title="Belum ada koordinat GPS"
                        description="Device ini belum pernah mengirim lokasi. Minta lokasi sekarang dari menu Device."
                    />
                    <div v-show="selectedDevice?.latitude != null" ref="mapEl" class="map h-[22rem] w-full" />
                </BaseCard>

                <BaseCard title="Pelanggaran" :count="violations.length" subtitle="Sejak halaman ini dibuka" flush>
                    <EmptyState
                        v-if="violations.length === 0"
                        :icon="ShieldAlert"
                        title="Belum ada pelanggaran"
                        description="Device yang keluar batas geofence akan tercatat di sini secara langsung."
                    />
                    <ol v-else class="divide-y divide-base-800/70">
                        <li v-for="v in violations" :key="v.id" class="flex gap-3 px-5 py-3.5">
                            <span class="led mt-1.5 text-danger-400" />
                            <div class="min-w-0">
                                <p class="truncate text-sm font-medium text-base-50">{{ v.device_name }}</p>
                                <p class="text-xs text-base-300">{{ VIOLATION_LABELS[v.violation_type] ?? v.violation_type }}</p>
                                <p class="mt-0.5 truncate font-mono text-[11px] text-base-500">
                                    {{ v.detected_value }} · {{ dayjs(v.detected_at).fromNow() }}
                                </p>
                            </div>
                        </li>
                    </ol>
                </BaseCard>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Tile OpenStreetMap dibalik jadi gelap supaya peta menyatu dengan panel */
.map :deep(.leaflet-tile-pane) {
    filter: invert(1) hue-rotate(180deg) brightness(0.82) contrast(0.92) saturate(0.6);
}

.map :deep(.leaflet-container) {
    background-color: var(--color-base-950);
    font-family: var(--font-sans);
}

.map :deep(.leaflet-popup-content-wrapper),
.map :deep(.leaflet-popup-tip) {
    background-color: var(--color-base-850);
    color: var(--color-base-50);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.5);
}

.map :deep(.leaflet-control-attribution) {
    background-color: rgb(5 7 10 / 0.7);
    color: var(--color-base-500);
}

.map :deep(.leaflet-control-attribution a) {
    color: var(--color-base-300);
}
</style>

<style scoped>
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
