<script setup>
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, LayoutGrid, Search } from '@lucide/vue'
import dayjs from 'dayjs'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import BaseButton from '@/components/ui/BaseButton.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { faceBackLabel, faceGaps } from '@/lib/faceLog'
import { formatDuration } from '@/lib/workStatus'

const ALL_SITES = 'all'
const SORTS = [
    { key: 'newest', label: 'Terbaru dulu' },
    { key: 'oldest', label: 'Terlama dulu' },
    { key: 'longest', label: 'Paling lama hilang' },
    { key: 'shortest', label: 'Paling singkat' },
]
const SORT_STORAGE_KEY = 'lacak_face_log_sort'

const toast = useToast()

const sites = ref([])
const roster = ref([])
const siteFilter = ref(ALL_SITES)
const day = ref(dayjs().startOf('day'))
const search = ref('')
const events = ref([])
const loading = ref(false)
const loadedOnce = ref(false)
const now = ref(Date.now())
const sort = ref(readSort())
let refreshTimer = null

const isToday = computed(() => day.value.isSame(dayjs(), 'day'))
const siteNames = computed(() => Object.fromEntries(sites.value.map((site) => [site.id, site.name])))
const dayStart = computed(() => day.value.valueOf())
const dayEnd = computed(() => day.value.endOf('day').valueOf() + 1)

function readSort() {
    try {
        const saved = localStorage.getItem(SORT_STORAGE_KEY)
        return SORTS.some((option) => option.key === saved) ? saved : 'newest'
    } catch {
        return 'newest'
    }
}

watch(sort, (value) => {
    try {
        localStorage.setItem(SORT_STORAGE_KEY, value)
    } catch {
        // urutan hanya kenyamanan -- abaikan kalau penyimpanan diblokir
    }
})

// ---- Data
async function loadRoster() {
    const response = await api.get('/live/overview')
    sites.value = response.data.data.sites
    roster.value = response.data.data.roster
    if (sites.value.length === 1) siteFilter.value = sites.value[0].id
}

async function loadEvents({ quiet = false } = {}) {
    if (!quiet) loading.value = true
    try {
        const params = {
            from: day.value.toISOString(),
            to: day.value.endOf('day').toISOString(),
            ...(siteFilter.value === ALL_SITES ? { all_sites: 1 } : { organization_id: siteFilter.value }),
        }
        const response = await api.get('/live/activity', { params })
        events.value = response.data.data.events
        now.value = Date.now()
        loadedOnce.value = true
    } catch (err) {
        if (!quiet) toast.error('Gagal memuat log wajah', err.response?.data?.message)
    } finally {
        loading.value = false
    }
}

watch([siteFilter, day], () => loadEvents())

onMounted(async () => {
    try {
        await loadRoster()
    } catch (err) {
        toast.error('Gagal memuat daftar staf', err.response?.data?.message)
    }
    await loadEvents()
    // Hari ini: selang yang masih berlangsung terus bertambah.
    refreshTimer = setInterval(() => {
        if (isToday.value) loadEvents({ quiet: true })
    }, 30_000)
})

onBeforeUnmount(() => clearInterval(refreshTimer))

// ---- Log
const rosterById = computed(() => new Map(roster.value.map((staff) => [staff.user_id, staff])))

const allGaps = computed(() => {
    const byUser = new Map()
    for (const event of events.value) {
        const at = new Date(event.occurred_at).getTime()
        if (at < dayStart.value || at >= dayEnd.value) continue
        if (!byUser.has(event.user_id)) byUser.set(event.user_id, [])
        byUser.get(event.user_id).push(event)
    }
    const endMs = Math.min(dayEnd.value, now.value)
    return [...byUser.entries()].flatMap(([userId, userEvents]) => {
        const staff = rosterById.value.get(userId)
        const name = staff?.name ?? userEvents[0].user_name ?? 'Staf'
        const siteId = staff?.organization_id ?? userEvents[0].organization_id
        return faceGaps(userEvents, endMs).map((gap) => ({ ...gap, userId, name, siteId, ms: gap.end - gap.start }))
    })
})

const COMPARE = {
    newest: (a, b) => b.start - a.start,
    oldest: (a, b) => a.start - b.start,
    longest: (a, b) => b.ms - a.ms || b.start - a.start,
    shortest: (a, b) => a.ms - b.ms || b.start - a.start,
}

const faceLog = computed(() => {
    const query = search.value.trim().toLowerCase()
    return allGaps.value.filter((gap) => !query || gap.name.toLowerCase().includes(query)).sort(COMPARE[sort.value])
})

const totalMs = computed(() => faceLog.value.reduce((total, gap) => total + gap.ms, 0))
const staffCount = computed(() => new Set(faceLog.value.map((gap) => gap.userId)).size)
const stillMissing = computed(() => faceLog.value.filter((gap) => gap.back === null).length)
const longest = computed(() => faceLog.value.reduce((max, gap) => Math.max(max, gap.ms), 0))

// Klik judul kolom: waktu -> terbaru/terlama, lama -> paling lama/paling singkat.
function toggleSort(column) {
    if (column === 'time') sort.value = sort.value === 'newest' ? 'oldest' : 'newest'
    else sort.value = sort.value === 'longest' ? 'shortest' : 'longest'
}

function ariaSort(column) {
    if (column === 'time') return { newest: 'descending', oldest: 'ascending' }[sort.value] ?? 'none'
    return { longest: 'descending', shortest: 'ascending' }[sort.value] ?? 'none'
}

// ---- Navigasi tanggal
function pickDate(event) {
    if (event.target.value) day.value = dayjs(event.target.value).startOf('day')
}

function shiftDay(delta) {
    const next = day.value.add(delta, 'day')
    if (next.isAfter(dayjs(), 'day')) return
    day.value = next
}

const dayLabel = computed(() => {
    if (isToday.value) return 'Hari ini'
    if (day.value.isSame(dayjs().subtract(1, 'day'), 'day')) return 'Kemarin'
    return day.value.format('dddd')
})

function downloadCsv() {
    const header = ['Tanggal', 'Staf', 'Site', 'Wajah tidak terlihat', 'Wajah kembali terlihat', 'Lama (menit)']
    const lines = faceLog.value.map((gap) => [
        dayjs(gap.start).format('YYYY-MM-DD'),
        gap.name,
        siteNames.value[gap.siteId] ?? '',
        dayjs(gap.start).format('HH:mm:ss'),
        faceBackLabel(gap),
        Math.round(gap.ms / 60_000),
    ])
    const csv = [header, ...lines].map((cells) => cells.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    const link = Object.assign(document.createElement('a'), { href: url, download: `log-wajah-${day.value.format('YYYY-MM-DD')}.csv` })
    link.click()
    URL.revokeObjectURL(url)
}
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Pantau"
            title="Log wajah hilang"
            subtitle="Kamera menyala tapi wajah tidak terlihat 5 menit atau lebih (yang lebih singkat tidak dicatat). Hanya catatan — jam kerja tetap dihitung."
        >
            <template #actions>
                <BaseButton v-if="faceLog.length" variant="outline" @click="downloadCsv">
                    <Download class="size-4" />
                    Unduh CSV
                </BaseButton>
            </template>
            <template #readouts>
                <Readout label="Kejadian" :value="faceLog.length" :led="faceLog.length ? 'warning' : 'muted'" />
                <Readout label="Staf" :value="staffCount" />
                <Readout label="Total lama" :value="formatDuration(totalMs / 1000)" />
                <Readout label="Terlama" :value="longest ? formatDuration(longest / 1000) : '—'" />
                <Readout v-if="isToday" label="Masih hilang" :value="stillMissing" :led="stillMissing ? 'danger' : 'muted'" />
            </template>
        </PageHeader>

        <div class="space-y-5 p-4 sm:p-8">
            <!-- Bilah kendali: tanggal, site, cari, urutan -->
            <div class="flex flex-wrap items-center gap-3 rounded-xl border border-base-800 bg-base-900 p-2 shadow-(--shadow-card)">
                <div class="flex items-center gap-1">
                    <BaseButton variant="ghost" size="icon" aria-label="Hari sebelumnya" @click="shiftDay(-1)">
                        <ChevronLeft class="size-4" />
                    </BaseButton>
                    <label class="relative">
                        <span class="sr-only">Tanggal</span>
                        <input
                            type="date"
                            :value="day.format('YYYY-MM-DD')"
                            :max="dayjs().format('YYYY-MM-DD')"
                            class="absolute inset-0 cursor-pointer opacity-0"
                            @change="pickDate"
                        />
                        <span class="flex min-w-36 flex-col rounded-lg px-3 py-1 text-center hover:bg-base-850">
                            <span class="text-sm font-semibold text-base-50">{{ dayLabel }}</span>
                            <span class="font-mono text-[10.5px] text-base-500 tabular-nums">{{ day.format('D MMM YYYY') }}</span>
                        </span>
                    </label>
                    <BaseButton variant="ghost" size="icon" aria-label="Hari berikutnya" :disabled="isToday" @click="shiftDay(1)">
                        <ChevronRight class="size-4" />
                    </BaseButton>
                </div>

                <div v-if="sites.length > 1" class="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="radiogroup" aria-label="Site">
                    <button
                        v-for="option in [{ id: ALL_SITES, name: 'Semua site' }, ...sites]"
                        :key="option.id"
                        type="button"
                        role="radio"
                        :aria-checked="siteFilter === option.id"
                        class="inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent-400"
                        :class="
                            siteFilter === option.id ? 'bg-accent-500 text-base-950' : 'text-base-300 hover:bg-base-850 hover:text-base-50'
                        "
                        @click="siteFilter = option.id"
                    >
                        <LayoutGrid v-if="option.id === ALL_SITES" class="size-4" />
                        {{ option.name }}
                    </button>
                </div>
                <p v-else class="flex-1 px-2 text-sm font-medium text-base-100">{{ sites[0]?.name }}</p>

                <label class="relative w-full sm:w-48">
                    <span class="sr-only">Urutkan</span>
                    <select v-model="sort" class="field-control !py-2">
                        <option v-for="option in SORTS" :key="option.key" :value="option.key">{{ option.label }}</option>
                    </select>
                </label>

                <label class="relative w-full sm:w-56">
                    <span class="sr-only">Cari staf</span>
                    <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                    <input v-model="search" type="search" placeholder="Cari staf…" class="field-control !py-2 pl-9" />
                </label>
            </div>

            <section
                class="overflow-hidden rounded-xl border border-base-800 bg-base-900 shadow-(--shadow-card)"
                aria-label="Log wajah hilang"
            >
                <p v-if="loading && !loadedOnce" class="px-5 py-10 text-center text-sm text-base-500">Memuat log wajah…</p>
                <p v-else-if="!faceLog.length" class="px-5 py-10 text-center text-sm text-base-500">
                    {{ search ? 'Tidak ada staf yang cocok dengan pencarian.' : `Tidak ada wajah hilang di ${dayLabel.toLowerCase()}.` }}
                </p>
                <div v-else class="overflow-x-auto">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Staf</th>
                                <th v-if="siteFilter === ALL_SITES">Site</th>
                                <th :aria-sort="ariaSort('time')">
                                    <button
                                        type="button"
                                        class="inline-flex items-center gap-1 hover:text-base-50 focus-visible:outline-2 focus-visible:outline-accent-400"
                                        :title="sort === 'newest' ? 'Urutkan dari yang terlama' : 'Urutkan dari yang terbaru'"
                                        @click="toggleSort('time')"
                                    >
                                        Wajah tidak terlihat
                                        <ArrowUp v-if="sort === 'oldest'" class="size-3.5 text-accent-400" />
                                        <ArrowDown v-else-if="sort === 'newest'" class="size-3.5 text-accent-400" />
                                    </button>
                                </th>
                                <th>Wajah kembali terlihat</th>
                                <th :aria-sort="ariaSort('duration')">
                                    <button
                                        type="button"
                                        class="inline-flex items-center gap-1 hover:text-base-50 focus-visible:outline-2 focus-visible:outline-accent-400"
                                        :title="sort === 'longest' ? 'Urutkan dari yang paling singkat' : 'Urutkan dari yang paling lama'"
                                        @click="toggleSort('duration')"
                                    >
                                        Lama
                                        <ArrowUp v-if="sort === 'shortest'" class="size-3.5 text-accent-400" />
                                        <ArrowDown v-else-if="sort === 'longest'" class="size-3.5 text-accent-400" />
                                    </button>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="gap in faceLog" :key="`${gap.userId}-${gap.start}`">
                                <td class="font-medium text-base-100">{{ gap.name }}</td>
                                <td v-if="siteFilter === ALL_SITES" class="text-base-400">{{ siteNames[gap.siteId] ?? '—' }}</td>
                                <td class="font-mono text-danger-400 tabular-nums">{{ dayjs(gap.start).format('HH:mm:ss') }}</td>
                                <td class="font-mono tabular-nums" :class="gap.back === 'face' ? 'text-base-100' : 'text-warning-400'">
                                    {{ faceBackLabel(gap) }}
                                </td>
                                <td class="font-mono text-base-300 tabular-nums">{{ formatDuration(gap.ms / 1000) }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    </div>
</template>
