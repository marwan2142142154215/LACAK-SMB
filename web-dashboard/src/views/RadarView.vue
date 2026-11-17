<script setup>
import { BatteryCharging, Crosshair, MapPin, Radar as RadarIcon, ShieldAlert, Users } from '@lucide/vue'
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
import { useTheme } from '@/composables/useTheme'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { locationQualityLabel } from '@/lib/deviceInfo'
import { useAuthStore } from '@/stores/auth'

dayjs.extend(relativeTime)

const auth = useAuthStore()
const { connect } = useGatewaySocket()
const { theme } = useTheme()
const toast = useToast()

const devices = reactive(new Map())
const violations = ref([])
const loading = ref(true)
const selectedDeviceId = ref(null)
const selectedStaffId = ref(null)
const selectedDevice = computed(() => (selectedDeviceId.value != null ? devices.get(selectedDeviceId.value) : null))

// Rel kiri: satu daftar dengan tab Device / Staf.
const activeTab = ref('device')

// --- Lokasi staf (agen HP/desktop) -- titik ungu di peta komando yang sama -------
// Titik lokasi milik USER (bukan device): GET /staff-locations (snapshot awal) lalu
// event socket `staff:location` (StaffLocationHub). Hanya pemegang radar.view menerima.
const staffLocations = reactive(new Map())
const staffList = computed(() =>
    Array.from(staffLocations.values())
        .filter((s) => s.latitude != null && s.longitude != null)
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
)

// Peta pakai Leaflet + tile OpenStreetMap (bukan iframe embed Google Maps yang membanjiri
// console dengan "message port closed"). Leaflet me-render peta sebagai elemen yang kita
// kontrol penuh, tanpa API key.
//
// SATU peta komando menampilkan SEMUA titik sekaligus: tiap device yang punya koordinat
// (warna titik = status) + tiap staf (titik ungu). Memilih device/staf menerbangkan peta
// ke titiknya dan menyorotnya -- bukan lagi satu peta per device.
const mapEl = ref(null)
let mapInstance = null
let markersLayer = null
// Lingkaran radius akurasi (meter) untuk device terpilih -- posisi asli ada di dalamnya.
let accuracyCircle = null
let hasFitBounds = false
let renderQueued = false
// Pegangan marker per-id supaya bisa buka popup / terbangkan dari daftar.
const deviceMarkers = new Map()
const staffMarkers = new Map()

const STATUS_PIN = { online: 'online', locked: 'locked', pending_enrollment: 'pending' }
const pinKind = (status) => STATUS_PIN[status] ?? 'offline'

function makePinIcon(kind, selected) {
    return L.divIcon({
        className: `geo-pin geo-pin--${kind}${selected ? ' is-selected' : ''}`,
        html: '<span class="geo-pin__pulse"></span><span class="geo-pin__dot"></span>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -13],
    })
}

// Nama (device/staf) diketik admin -> dikirim sebagai node teks ke popup, bukan innerHTML
// (cegah stored XSS ke super_admin yang membuka Radar).
function textPopup(name) {
    const el = document.createElement('span')
    el.className = 'geo-popup'
    el.textContent = name ?? ''
    return el
}

const mappedDeviceCount = computed(() => deviceList.value.filter((d) => d.latitude != null && d.longitude != null).length)
const hasAnyPoint = computed(() => mappedDeviceCount.value > 0 || staffList.value.length > 0)

function ensureMap() {
    if (mapInstance || !mapEl.value) return
    // Default: seluruh Indonesia, sampai fitBounds menyesuaikan ke titik nyata.
    mapInstance = L.map(mapEl.value, { attributionControl: true, zoomControl: true }).setView([-2.5, 118], 4)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
    }).addTo(mapInstance)
    markersLayer = L.layerGroup().addTo(mapInstance)
}

function renderAllMarkers() {
    renderQueued = false
    ensureMap()
    if (!mapInstance) return
    markersLayer.clearLayers()
    deviceMarkers.clear()
    staffMarkers.clear()
    const bounds = []

    for (const d of deviceList.value) {
        if (d.latitude == null || d.longitude == null) continue
        const lat = Number(d.latitude)
        const lng = Number(d.longitude)
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
        bounds.push([lat, lng])
        const selected = d.device_id === selectedDeviceId.value
        const marker = L.marker([lat, lng], {
            icon: makePinIcon(pinKind(d.status), selected),
            zIndexOffset: selected ? 1000 : 0,
            alt: d.device_name ?? 'Device',
        })
        marker.on('click', () => {
            selectedStaffId.value = null
            selectedDeviceId.value = d.device_id
        })
        marker.bindPopup(textPopup(d.device_name))
        markersLayer.addLayer(marker)
        deviceMarkers.set(d.device_id, marker)
    }

    for (const s of staffList.value) {
        const lat = Number(s.latitude)
        const lng = Number(s.longitude)
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
        bounds.push([lat, lng])
        const selected = s.user_id === selectedStaffId.value
        const marker = L.marker([lat, lng], {
            icon: makePinIcon('staff', selected),
            zIndexOffset: selected ? 1000 : 0,
            alt: s.name ?? 'Staf',
        })
        marker.on('click', () => {
            selectedDeviceId.value = null
            selectedStaffId.value = s.user_id
            marker.openPopup()
        })
        marker.bindPopup(textPopup(s.name))
        markersLayer.addLayer(marker)
        staffMarkers.set(s.user_id, marker)
    }

    // Sekali saja saat pertama ada titik: pas-kan peta ke semua titik. Setelah itu biarkan
    // view yang dipilih operator (atau flyTo saat memilih device).
    if (!hasFitBounds && bounds.length) {
        mapInstance.fitBounds(bounds, { padding: [48, 48], maxZoom: 16 })
        hasFitBounds = true
    }
    requestAnimationFrame(() => mapInstance?.invalidateSize())
}

function scheduleRender() {
    if (renderQueued) return
    renderQueued = true
    nextTick(renderAllMarkers)
}

// Lingkaran akurasi mengikuti device terpilih.
function drawAccuracy(device) {
    if (!mapInstance) return
    const lat = Number(device.latitude)
    const lng = Number(device.longitude)
    const accuracy = Number(device.accuracy_meters)
    if (device.accuracy_meters != null && Number.isFinite(accuracy) && accuracy > 0) {
        if (!accuracyCircle) {
            accuracyCircle = L.circle([lat, lng], {
                radius: accuracy,
                color: '#f59e0b',
                weight: 1,
                fillColor: '#f59e0b',
                fillOpacity: 0.12,
                interactive: false,
            }).addTo(mapInstance)
        } else {
            accuracyCircle.setLatLng([lat, lng]).setRadius(accuracy)
        }
    } else if (accuracyCircle) {
        accuracyCircle.remove()
        accuracyCircle = null
    }
}

function focusDevice(device) {
    renderAllMarkers()
    if (!mapInstance || device?.latitude == null) return
    const lat = Number(device.latitude)
    const lng = Number(device.longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
    mapInstance.flyTo([lat, lng], Math.max(mapInstance.getZoom(), 16), { duration: 0.6 })
    drawAccuracy(device)
    deviceMarkers.get(device.device_id)?.openPopup()
}

function focusStaff(staff) {
    renderAllMarkers()
    if (!mapInstance || staff?.latitude == null) return
    const lat = Number(staff.latitude)
    const lng = Number(staff.longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
    mapInstance.flyTo([lat, lng], Math.max(mapInstance.getZoom(), 16), { duration: 0.6 })
    staffMarkers.get(staff.user_id)?.openPopup()
}

function selectDeviceFromList(d) {
    selectedStaffId.value = null
    selectedDeviceId.value = d.device_id
}

function selectStaffFromList(s) {
    selectedDeviceId.value = null
    selectedStaffId.value = s.user_id
    focusStaff(s)
}

watch(selectedDevice, async (device) => {
    if (accuracyCircle && (!device || device.latitude == null)) {
        accuracyCircle.remove()
        accuracyCircle = null
    }
    if (device?.latitude == null) {
        renderAllMarkers()
        return
    }
    await nextTick()
    focusDevice(device)
})

onBeforeUnmount(() => {
    mapInstance?.remove()
    mapInstance = null
    markersLayer = null
    accuracyCircle = null
})

async function loadStaffLocations() {
    try {
        const response = await api.get('/staff-locations')
        for (const item of response.data.data.items) {
            const loc = item.last_location
            if (!loc || loc.latitude == null) continue
            staffLocations.set(item.user_id, {
                user_id: item.user_id,
                name: item.user_name,
                latitude: loc.latitude,
                longitude: loc.longitude,
                accuracy_meters: loc.accuracy_meters,
                source: loc.source,
                confidence: loc.confidence,
                is_mock: loc.is_mock,
                captured_at: loc.captured_at,
            })
        }
        await nextTick()
        renderAllMarkers()
    } catch (err) {
        // Butuh radar.view; 401 ditangani interceptor global, 403 = memang tak boleh.
        if (err.response?.status && ![401, 403].includes(err.response.status)) {
            toast.error('Gagal memuat lokasi staf', err.response?.data?.message)
        }
    }
}

// Subjudul detail: umur posisi + kualitas fix, dan peringatan bila GPS belum dapat posisi baru.
const selectedMeta = computed(() => {
    const d = selectedDevice.value
    if (!d?.recorded_at) return null
    const parts = [`Posisi ${dayjs(d.fixed_at ?? d.recorded_at).fromNow()}`]
    const quality = locationQualityLabel(d)
    if (quality) parts.push(quality)
    if (d.fixed_at && dayjs(d.recorded_at).diff(d.fixed_at, 'minute') >= 2) parts.push('GPS belum dapat posisi baru')
    return parts.join(' · ')
})

const RADAR_MAX_METERS = 200

// Urutan daftar: yang perlu perhatian dulu (terkunci), lalu online, lalu sisanya.
const STATUS_ORDER = { locked: 0, online: 1, pending_enrollment: 2, offline: 3 }
const deviceList = computed(() =>
    Array.from(devices.values()).sort(
        (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || (a.device_name ?? '').localeCompare(b.device_name ?? ''),
    ),
)

// Peta ikut berubah saat data device/staf berubah (tanpa refit, supaya view operator tetap).
watch([deviceList, staffList], scheduleRender)

const onlineCount = computed(() => deviceList.value.filter((d) => d.status === 'online').length)
const lockedCount = computed(() => deviceList.value.filter((d) => d.status === 'locked').length)

// Skala radar menyesuaikan device terjauh (kelipatan 50 m, maks 200 m).
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
                accuracy_meters: d.latest_location?.accuracy_meters ?? null,
                location_provider: d.latest_location?.location_provider ?? null,
                fixed_at: d.latest_location?.fixed_at ?? null,
                is_mock: d.latest_location?.is_mock ?? false,
                recorded_at: d.latest_location?.recorded_at ?? null,
                is_charging: d.is_charging ?? null,
                last_seen_at: d.last_seen_at ?? null,
            })
        }
        return true
    } catch (err) {
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
    await nextTick()
    renderAllMarkers()
    if (selectedDevice.value?.latitude != null) focusDevice(selectedDevice.value)

    const organizationId = auth.isSuperAdmin ? null : auth.user?.organization_id
    const socket = connect(organizationId)

    socket.on('radar:update', (payload) => {
        // device_id dipaksa number: gateway (Lucid/node-postgres) bisa kirim bigint sebagai
        // string, beda dengan REST (Laravel). Key Map selalu number supaya get() tak gagal.
        const id = Number(payload.device_id)
        const existing = devices.get(id) ?? {}
        const update = payload.latitude == null
            ? Object.fromEntries(
                  Object.entries(payload).filter(
                      ([key]) => !['latitude', 'longitude', 'accuracy_meters', 'location_provider', 'fixed_at', 'recorded_at'].includes(key),
                  ),
              )
            : payload
        devices.set(id, { ...existing, ...update, device_id: id })
        if (payload.latitude != null) scheduleRender()
        if (id === selectedDeviceId.value && payload.latitude != null) focusDevice(devices.get(id))
    })

    socket.on('device:status', (payload) => {
        const id = Number(payload.device_id)
        const existing = devices.get(id) ?? {}
        devices.set(id, { ...existing, ...payload, device_id: id })
        scheduleRender()
    })

    socket.on('violation:alert', (payload) => {
        violations.value.unshift({ ...payload, id: Date.now() })
        violations.value = violations.value.slice(0, 8)
    })

    socket.on('staff:location', (payload) => {
        if (payload.latitude == null || payload.longitude == null) return
        staffLocations.set(payload.user_id, {
            user_id: payload.user_id,
            name: payload.name,
            latitude: payload.latitude,
            longitude: payload.longitude,
            accuracy_meters: payload.accuracy_meters,
            source: payload.source,
            confidence: payload.confidence,
            is_mock: payload.is_mock,
            captured_at: payload.captured_at,
        })
        scheduleRender()
    })

    await loadStaffLocations()
})
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Pantau"
            title="Radar"
            subtitle="Semua posisi device dan staf, langsung di satu peta. Pilih titik atau nama untuk melihat detailnya."
        >
            <template v-if="!loading" #readouts>
                <Readout label="Device online" :value="`${onlineCount}/${deviceList.length}`" led="accent" />
                <Readout label="Di peta" :value="mappedDeviceCount" led="muted" />
                <Readout label="Staf terpantau" :value="staffList.length" :led="staffList.length ? 'warning' : 'muted'" />
                <Readout label="Terkunci" :value="lockedCount" :led="lockedCount ? 'danger' : 'muted'" />
            </template>
        </PageHeader>

        <div class="space-y-6 p-4 sm:p-8">
            <!-- PETA KOMANDO: satu peta berisi semua titik, rel daftar di kiri -->
            <div class="grid gap-5 lg:grid-cols-[21rem_minmax(0,1fr)]">
                <!-- Rel kiri: daftar device/staf, klik untuk menyorot di peta -->
                <BaseCard flush class="order-2 lg:order-1">
                    <div class="flex border-b border-base-800" role="tablist" aria-label="Daftar titik">
                        <button
                            type="button"
                            role="tab"
                            :aria-selected="activeTab === 'device'"
                            class="tab-btn"
                            :class="activeTab === 'device' && 'is-active'"
                            @click="activeTab = 'device'"
                        >
                            Device <span class="tab-count">{{ deviceList.length }}</span>
                        </button>
                        <button
                            type="button"
                            role="tab"
                            :aria-selected="activeTab === 'staff'"
                            class="tab-btn"
                            :class="activeTab === 'staff' && 'is-active'"
                            @click="activeTab = 'staff'"
                        >
                            Staf <span class="tab-count">{{ staffList.length }}</span>
                        </button>
                    </div>

                    <!-- Tab device -->
                    <div v-if="activeTab === 'device'" class="h-[20rem] overflow-y-auto lg:h-[calc(40rem-3.25rem)]">
                        <div v-if="loading" class="px-5 py-12 text-center text-sm text-base-500">Memuat device…</div>
                        <EmptyState
                            v-else-if="deviceList.length === 0"
                            :icon="RadarIcon"
                            title="Radar masih kosong"
                            description="Device muncul di sini setelah APK pelacak terpasang dan terhubung."
                        />
                        <ul v-else class="divide-y divide-base-800/70">
                            <li v-for="d in deviceList" :key="d.device_id">
                                <button
                                    type="button"
                                    class="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-base-850 focus-visible:bg-base-850 focus-visible:outline-none"
                                    :class="selectedDeviceId === d.device_id && 'bg-base-850 shadow-[inset_2px_0_0_var(--color-accent-500)]'"
                                    :aria-pressed="selectedDeviceId === d.device_id"
                                    @click="selectDeviceFromList(d)"
                                >
                                    <span class="geo-pin-mini" :class="`geo-pin-mini--${pinKind(d.status)}`" aria-hidden="true" />
                                    <div class="min-w-0 flex-1">
                                        <p class="truncate text-sm font-medium text-base-50">{{ d.device_name }}</p>
                                        <div class="mt-1 flex items-center gap-2">
                                            <StatusDot :status="d.status" />
                                            <span
                                                v-if="d.is_mock"
                                                class="rounded bg-danger-500/15 px-1.5 py-0.5 text-[11px] text-danger-400"
                                                title="Lokasi terdeteksi palsu (mock location)"
                                                >Lokasi palsu?</span
                                            >
                                        </div>
                                    </div>
                                    <div class="shrink-0 text-right font-mono text-xs tabular-nums">
                                        <p class="text-base-100">
                                            {{ d.ble_distance_meters != null ? `${Number(d.ble_distance_meters).toFixed(1)} m` : '—' }}
                                        </p>
                                        <p
                                            class="mt-1 inline-flex items-center gap-1"
                                            :class="d.battery_level != null && d.battery_level < 20 && !d.is_charging ? 'text-danger-400' : 'text-base-500'"
                                        >
                                            <BatteryCharging v-if="d.is_charging" class="size-3 text-accent-400" aria-label="Mengisi daya" />
                                            {{ d.battery_level != null ? `${d.battery_level}%` : '' }}
                                        </p>
                                    </div>
                                </button>
                            </li>
                        </ul>
                    </div>

                    <!-- Tab staf -->
                    <div v-else class="h-[20rem] overflow-y-auto lg:h-[calc(40rem-3.25rem)]">
                        <EmptyState
                            v-if="staffList.length === 0"
                            :icon="Users"
                            title="Belum ada lokasi staf"
                            description="Lokasi muncul saat staf login lewat APK atau aplikasi desktop dengan lokasi menyala."
                        />
                        <ul v-else class="divide-y divide-base-800/70">
                            <li v-for="s in staffList" :key="s.user_id">
                                <button
                                    type="button"
                                    class="flex w-full items-start gap-3 px-5 py-3 text-left transition-colors hover:bg-base-850 focus-visible:bg-base-850 focus-visible:outline-none"
                                    :class="selectedStaffId === s.user_id && 'bg-base-850 shadow-[inset_2px_0_0_#a855f7]'"
                                    :aria-pressed="selectedStaffId === s.user_id"
                                    @click="selectStaffFromList(s)"
                                >
                                    <span class="geo-pin-mini geo-pin-mini--staff mt-0.5" aria-hidden="true" />
                                    <div class="min-w-0 flex-1">
                                        <p class="truncate text-sm font-medium text-base-50">{{ s.name }}</p>
                                        <p class="mt-0.5 text-xs text-base-400">{{ dayjs(s.captured_at).fromNow() }}</p>
                                        <div class="mt-1 flex flex-wrap gap-1">
                                            <span
                                                v-if="s.is_mock"
                                                class="rounded bg-danger-500/15 px-1.5 py-0.5 text-[11px] text-danger-400"
                                                >Lokasi palsu?</span
                                            >
                                            <span
                                                v-else-if="s.confidence === 'low'"
                                                class="rounded bg-base-800 px-1.5 py-0.5 text-[11px] text-base-400"
                                                >Akurasi rendah</span
                                            >
                                        </div>
                                    </div>
                                </button>
                            </li>
                        </ul>
                    </div>
                </BaseCard>

                <!-- Peta besar: semua titik sekaligus -->
                <div
                    class="map-shell relative order-1 h-[24rem] overflow-hidden rounded-lg border border-base-800 shadow-(--shadow-card) sm:h-[32rem] lg:order-2 lg:h-[40rem]"
                    :class="theme === 'dark' ? 'is-dark' : 'is-light'"
                >
                    <div ref="mapEl" class="map absolute inset-0" />

                    <!-- Legenda warna titik (kiri atas) -->
                    <div class="pointer-events-none absolute top-3 left-3 z-[500] flex flex-wrap gap-x-3 gap-y-1.5 rounded-lg border border-base-800 bg-base-900/85 px-3 py-2 text-[11px] font-medium text-base-300 shadow-(--shadow-card) backdrop-blur-md">
                        <span class="flex items-center gap-1.5"><span class="geo-pin-mini geo-pin-mini--online" /> Online</span>
                        <span class="flex items-center gap-1.5"><span class="geo-pin-mini geo-pin-mini--locked" /> Terkunci</span>
                        <span class="flex items-center gap-1.5"><span class="geo-pin-mini geo-pin-mini--offline" /> Offline</span>
                        <span class="flex items-center gap-1.5"><span class="geo-pin-mini geo-pin-mini--staff" /> Staf</span>
                    </div>

                    <!-- Belum ada titik sama sekali -->
                    <div
                        v-if="!loading && !hasAnyPoint"
                        class="pointer-events-none absolute inset-0 z-[500] flex flex-col items-center justify-center gap-2 bg-base-950/40 text-center backdrop-blur-sm"
                    >
                        <MapPin class="size-7 text-base-500" />
                        <p class="text-sm font-medium text-base-200">Belum ada posisi</p>
                        <p class="max-w-xs text-xs text-base-400">Titik device dan staf muncul di peta begitu agen mengirim lokasi.</p>
                    </div>

                    <!-- Detail device terpilih (kiri bawah) -->
                    <div
                        v-if="selectedDevice"
                        class="absolute bottom-3 left-3 z-[500] w-[min(20rem,calc(100%-1.5rem))] rounded-lg border border-base-800 bg-base-900/90 p-3.5 shadow-lg backdrop-blur-md"
                    >
                        <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0">
                                <p class="truncate font-display text-sm font-semibold text-base-50">{{ selectedDevice.device_name }}</p>
                                <div class="mt-1 flex items-center gap-2">
                                    <StatusDot :status="selectedDevice.status" />
                                    <span
                                        v-if="selectedDevice.is_mock"
                                        class="rounded bg-danger-500/15 px-1.5 py-0.5 text-[11px] text-danger-400"
                                        >⚠ Lokasi palsu</span
                                    >
                                </div>
                            </div>
                            <button
                                type="button"
                                class="flex size-7 shrink-0 items-center justify-center rounded-md text-base-400 transition-colors hover:bg-base-800 hover:text-base-50"
                                aria-label="Terbangkan ulang ke titik ini"
                                title="Pusatkan peta"
                                @click="focusDevice(selectedDevice)"
                            >
                                <Crosshair class="size-4" />
                            </button>
                        </div>
                        <dl v-if="selectedDevice.latitude != null" class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                            <div>
                                <dt class="text-base-500">Jarak BLE</dt>
                                <dd class="font-mono text-base-100 tabular-nums">
                                    {{ selectedDevice.ble_distance_meters != null ? `${Number(selectedDevice.ble_distance_meters).toFixed(1)} m` : '—' }}
                                </dd>
                            </div>
                            <div>
                                <dt class="text-base-500">Baterai</dt>
                                <dd class="font-mono text-base-100 tabular-nums">{{ selectedDevice.battery_level != null ? `${selectedDevice.battery_level}%` : '—' }}</dd>
                            </div>
                        </dl>
                        <p v-if="selectedMeta" class="mt-2.5 border-t border-base-800 pt-2 text-[11px] text-base-400">{{ selectedMeta }}</p>
                        <p v-else-if="selectedDevice.latitude == null" class="mt-2.5 border-t border-base-800 pt-2 text-[11px] text-base-400">
                            Belum ada koordinat GPS. Minta lokasi dari menu Device.
                        </p>
                    </div>
                </div>
            </div>

            <!-- Pendukung: radar BLE (jarak dari anchor) + pelanggaran langsung -->
            <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
                <BaseCard title="Radar BLE" subtitle="Anchor di tengah · jarak diperkirakan dari kekuatan sinyal BLE">
                    <div class="mx-auto w-full max-w-[32rem] py-2">
                        <RadarScope
                            :devices="scopeDevices"
                            :selected-id="selectedDeviceId"
                            :max-meters="scopeMaxMeters"
                            @select="selectDeviceFromList({ device_id: $event })"
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
.tab-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.75rem 0.5rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-base-500);
    border-bottom: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s;
}

.tab-btn:hover {
    color: var(--color-base-100);
}

.tab-btn.is-active {
    color: var(--color-base-50);
    border-bottom-color: var(--color-accent-500);
}

.tab-count {
    min-width: 1.25rem;
    border-radius: 9999px;
    background-color: var(--color-base-850);
    padding: 0.0625rem 0.375rem;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
    color: var(--color-base-500);
}

.tab-btn.is-active .tab-count {
    background-color: color-mix(in oklab, var(--color-accent-500) 18%, transparent);
    color: var(--color-accent-500);
}

/* Titik mini di daftar & legenda: warna = status */
.geo-pin-mini {
    display: inline-block;
    width: 0.625rem;
    height: 0.625rem;
    flex-shrink: 0;
    border-radius: 9999px;
    border: 2px solid var(--color-base-900);
    box-shadow: 0 0 0 1px color-mix(in oklab, currentColor 40%, transparent);
}

.geo-pin-mini--online {
    background-color: var(--color-accent-500);
    color: var(--color-accent-500);
}
.geo-pin-mini--locked {
    background-color: var(--color-danger-500);
    color: var(--color-danger-500);
}
.geo-pin-mini--offline {
    background-color: var(--color-base-500);
    color: var(--color-base-500);
}
.geo-pin-mini--pending {
    background-color: var(--color-copper-500);
    color: var(--color-copper-500);
}
.geo-pin-mini--staff {
    background-color: #a855f7;
    color: #a855f7;
}

/* Tile: terang di tema terang, dibalik gelap di tema gelap supaya menyatu panel */
.map-shell.is-light .map :deep(.leaflet-tile-pane) {
    filter: saturate(0.9) brightness(1.02);
}

.map-shell.is-dark .map :deep(.leaflet-tile-pane) {
    filter: invert(1) hue-rotate(180deg) brightness(0.82) contrast(0.92) saturate(0.6);
}

.map :deep(.leaflet-container) {
    background-color: var(--color-base-850);
    font-family: var(--font-sans);
}

/* Penanda peta: titik berwarna status, cincin putih, denyut lembut. */
.map :deep(.geo-pin) {
    border: 0;
    background: transparent;
}

.map :deep(.geo-pin__dot) {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 15px;
    height: 15px;
    border: 3px solid #fff;
    border-radius: 9999px;
    box-shadow: 0 2px 6px rgb(0 0 0 / 0.4);
}

.map :deep(.geo-pin__pulse) {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 15px;
    height: 15px;
    border-radius: 9999px;
    opacity: 0.55;
}

.map :deep(.geo-pin--online .geo-pin__dot) {
    background: var(--color-accent-500);
}
.map :deep(.geo-pin--online .geo-pin__pulse) {
    background: var(--color-accent-500);
}
.map :deep(.geo-pin--locked .geo-pin__dot) {
    background: var(--color-danger-500);
}
.map :deep(.geo-pin--locked .geo-pin__pulse) {
    background: var(--color-danger-500);
}
.map :deep(.geo-pin--offline .geo-pin__dot) {
    background: var(--color-base-500);
}
.map :deep(.geo-pin--offline .geo-pin__pulse) {
    background: var(--color-base-500);
}
.map :deep(.geo-pin--pending .geo-pin__dot) {
    background: var(--color-copper-500);
}
.map :deep(.geo-pin--pending .geo-pin__pulse) {
    background: var(--color-copper-500);
}
.map :deep(.geo-pin--staff .geo-pin__dot) {
    background: #a855f7;
}
.map :deep(.geo-pin--staff .geo-pin__pulse) {
    background: #a855f7;
}

/* Titik terpilih: lebih besar + cincin denyut */
.map :deep(.geo-pin.is-selected .geo-pin__dot) {
    width: 19px;
    height: 19px;
    box-shadow: 0 0 0 4px color-mix(in oklab, currentColor 10%, transparent), 0 2px 8px rgb(0 0 0 / 0.45);
}

.map :deep(.geo-pin.is-selected .geo-pin__pulse) {
    animation: geo-ping 1.8s ease-out infinite;
}

@keyframes geo-ping {
    0% {
        transform: scale(1);
        opacity: 0.5;
    }
    100% {
        transform: scale(3.2);
        opacity: 0;
    }
}

@media (prefers-reduced-motion: reduce) {
    .map :deep(.geo-pin.is-selected .geo-pin__pulse) {
        animation: none;
    }
}

.map :deep(.leaflet-popup-content-wrapper),
.map :deep(.leaflet-popup-tip) {
    background-color: var(--color-base-900);
    color: var(--color-base-50);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.3);
}

.map :deep(.geo-popup) {
    font-weight: 500;
}

.map :deep(.leaflet-control-attribution) {
    background-color: color-mix(in oklab, var(--color-base-900) 82%, transparent);
    color: var(--color-base-500);
}

.map :deep(.leaflet-control-attribution a) {
    color: var(--color-base-400);
}

.map :deep(.leaflet-bar) {
    border: 1px solid var(--color-base-800);
    box-shadow: var(--shadow-card);
}

.map :deep(.leaflet-bar a) {
    background-color: var(--color-base-900);
    border-bottom-color: var(--color-base-800);
    color: var(--color-base-100);
}

.map :deep(.leaflet-bar a:hover) {
    background-color: var(--color-base-850);
}
</style>
