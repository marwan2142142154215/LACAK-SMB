<script setup>
import { Film, MonitorUp, UserRound, Video } from '@lucide/vue'
import dayjs from 'dayjs'
import { computed, onMounted, ref, watch } from 'vue'

import BaseSelect from '@/components/ui/BaseSelect.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'

// Rekaman video penuh Live Kerja (LiveKit Egress -> DigitalOcean Spaces),
// dipotong per jam. Disimpan 3 hari lalu dihapus otomatis oleh server.
const RETENTION_DAYS = 3

const toast = useToast()

const sites = ref([])
const roster = ref([])
const siteId = ref(null)
const userId = ref(null)
const dayOffset = ref(0) // 0 = hari ini, 1 = kemarin, ...
const items = ref([])
const enabled = ref(true)
const loading = ref(false)
const loaded = ref(false)

const dayOptions = computed(() =>
    Array.from({ length: RETENTION_DAYS }, (_, offset) => {
        const day = dayjs().subtract(offset, 'day')
        const label = offset === 0 ? 'Hari ini' : offset === 1 ? 'Kemarin' : day.format('dddd')
        return { offset, label, date: day.format('D MMM') }
    }),
)

const staffOptions = computed(() =>
    roster.value
        .filter((staff) => !siteId.value || staff.organization_id === siteId.value)
        .sort((a, b) => a.name.localeCompare(b.name)),
)

// Satu baris per jam: layar + kamera yang dimulai di jam itu.
const hours = computed(() => {
    const groups = new Map()
    for (const item of items.value) {
        const key = dayjs(item.started_at).startOf('hour').valueOf()
        if (!groups.has(key)) groups.set(key, { key, screen: [], camera: [] })
        groups.get(key)[item.source === 'camera' ? 'camera' : 'screen'].push(item)
    }
    return [...groups.values()].sort((a, b) => a.key - b.key)
})

const STATUS_LABELS = {
    recording: 'Sedang direkam',
    rotating: 'Sedang direkam',
    failed: 'Gagal direkam',
}

function timeRange(item) {
    const start = dayjs(item.started_at).format('HH:mm')
    return item.ended_at ? `${start}–${dayjs(item.ended_at).format('HH:mm')}` : `${start}–sekarang`
}

function sizeLabel(bytes) {
    if (!bytes) return null
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

async function loadRoster() {
    const response = await api.get('/live/overview')
    sites.value = response.data.data.sites
    roster.value = response.data.data.roster
    if (sites.value.length === 1) siteId.value = sites.value[0].id
}

async function loadRecordings() {
    if (!userId.value) {
        items.value = []
        return
    }
    loading.value = true
    try {
        const day = dayjs().subtract(dayOffset.value, 'day')
        const response = await api.get('/live/recordings', {
            params: {
                user_id: userId.value,
                from: day.startOf('day').toISOString(),
                to: day.endOf('day').toISOString(),
            },
        })
        enabled.value = response.data.data.enabled
        items.value = response.data.data.items
        loaded.value = true
    } catch (err) {
        toast.error('Gagal memuat rekaman', err.response?.data?.message)
    } finally {
        loading.value = false
    }
}

watch(siteId, () => {
    if (userId.value && !staffOptions.value.some((staff) => staff.user_id === userId.value)) userId.value = null
})
watch([userId, dayOffset], loadRecordings)

onMounted(async () => {
    try {
        await loadRoster()
    } catch (err) {
        toast.error('Gagal memuat daftar staf', err.response?.data?.message)
    }
})
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Pantau"
            title="Rekaman"
            subtitle="Putar ulang layar dan kamera staf selama Live Kerja. Rekaman dipotong per jam dan dihapus otomatis setelah 3 hari."
        />

        <div class="space-y-5 p-4 sm:p-8">
            <div class="grid gap-3 rounded-xl border border-base-800 bg-base-900 p-3 shadow-(--shadow-card) sm:grid-cols-[1fr_1.4fr_auto]">
                <BaseSelect v-if="sites.length > 1" v-model="siteId" label="Site">
                    <option :value="null">Semua site</option>
                    <option v-for="site in sites" :key="site.id" :value="site.id">{{ site.name }}</option>
                </BaseSelect>
                <BaseSelect v-model="userId" label="Staf" :class="sites.length > 1 ? '' : 'sm:col-span-2'">
                    <option :value="null">Pilih staf…</option>
                    <option v-for="staff in staffOptions" :key="staff.user_id" :value="staff.user_id">{{ staff.name }}</option>
                </BaseSelect>
                <div>
                    <span class="field-label">Tanggal</span>
                    <div class="flex overflow-hidden rounded-lg border border-base-700" role="group" aria-label="Tanggal rekaman">
                        <button
                            v-for="option in dayOptions"
                            :key="option.offset"
                            type="button"
                            class="flex flex-col px-3 py-1.5 text-left transition-colors"
                            :class="dayOffset === option.offset ? 'bg-accent-500/15 text-accent-300' : 'text-base-300 hover:bg-base-850'"
                            :aria-pressed="dayOffset === option.offset"
                            @click="dayOffset = option.offset"
                        >
                            <span class="text-sm font-medium">{{ option.label }}</span>
                            <span class="font-mono text-[10.5px] text-base-500 tabular-nums">{{ option.date }}</span>
                        </button>
                    </div>
                </div>
            </div>

            <div class="rounded-xl border border-base-800 bg-base-900 shadow-(--shadow-card)">
                <EmptyState v-if="!userId" :icon="UserRound" title="Pilih staf" description="Pilih staf dan tanggal untuk memutar ulang rekamannya." />
                <EmptyState
                    v-else-if="loaded && !enabled"
                    :icon="Film"
                    title="Rekaman belum aktif"
                    description="Penyimpanan DigitalOcean Spaces belum diisi di server, jadi Live Kerja tidak direkam."
                />
                <EmptyState
                    v-else-if="loaded && !loading && !hours.length"
                    :icon="Film"
                    title="Tidak ada rekaman"
                    description="Staf ini tidak Live Kerja pada tanggal tersebut, atau rekamannya sudah lewat 3 hari."
                />
                <ul v-else class="divide-y divide-base-800">
                    <li v-for="hour in hours" :key="hour.key" class="p-4 sm:p-5">
                        <p class="mb-3 font-mono text-sm font-medium text-base-100 tabular-nums">
                            {{ dayjs(hour.key).format('HH:00') }} – {{ dayjs(hour.key).add(1, 'hour').format('HH:00') }}
                        </p>
                        <div class="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
                            <div v-for="column in ['screen', 'camera']" :key="column" class="space-y-3">
                                <p class="eyebrow flex items-center gap-1.5">
                                    <component :is="column === 'screen' ? MonitorUp : Video" class="size-3.5" />
                                    {{ column === 'screen' ? 'Layar' : 'Kamera' }}
                                </p>
                                <p v-if="!hour[column].length" class="text-sm text-base-500">Tidak ada rekaman.</p>
                                <div v-for="item in hour[column]" :key="item.id" class="space-y-1.5">
                                    <video
                                        v-if="item.url"
                                        :src="item.url"
                                        controls
                                        preload="none"
                                        class="aspect-video w-full rounded-lg border border-base-800 bg-black"
                                    />
                                    <div
                                        v-else
                                        class="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed border-base-700 text-sm text-base-500"
                                    >
                                        {{ STATUS_LABELS[item.status] ?? 'Belum tersedia' }}
                                    </div>
                                    <p class="flex justify-between font-mono text-[11px] text-base-500 tabular-nums">
                                        <span>{{ timeRange(item) }}</span>
                                        <span>{{ sizeLabel(item.size_bytes) }}</span>
                                    </p>
                                </div>
                            </div>
                        </div>
                    </li>
                </ul>
            </div>
        </div>
    </div>
</template>
