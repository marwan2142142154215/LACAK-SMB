<script setup>
import { Battery, BatteryLow, Lock, LockOpen, Radar as RadarIcon, Wifi, WifiOff } from '@lucide/vue'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { computed, onMounted, reactive, ref } from 'vue'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useGatewaySocket } from '@/composables/useGatewaySocket'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

dayjs.extend(relativeTime)

const auth = useAuthStore()
const { connect } = useGatewaySocket()

const devices = reactive(new Map())
const violations = ref([])
const loading = ref(true)

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
    } finally {
        loading.value = false
    }
}

onMounted(async () => {
    await loadInitialDevices()

    const organizationId = auth.isSuperAdmin ? null : auth.user?.organization_id
    const socket = connect(organizationId)

    socket.on('radar:update', (payload) => {
        const existing = devices.get(Number(payload.device_id)) ?? {}
        devices.set(Number(payload.device_id), { ...existing, ...payload })
    })

    socket.on('device:status', (payload) => {
        const existing = devices.get(Number(payload.device_id)) ?? {}
        devices.set(Number(payload.device_id), { ...existing, ...payload })
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
                        class="rounded-xl border border-base-800 bg-base-850/60 p-4"
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
        </div>
    </div>
</template>
