<script setup>
import { ChevronDown, ChevronLeft, ChevronRight, LayoutGrid, Search, UserRound, X } from '@lucide/vue'
import dayjs from 'dayjs'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import BaseButton from '@/components/ui/BaseButton.vue'
import Readout from '@/components/ui/Readout.vue'
import { useToast } from '@/composables/useToast'
import { CHART_GROUPS, buildSegments, clipSegments, groupTotals } from '@/lib/activityTimeline'
import api from '@/lib/api'
import { WORK_EVENT_LABELS, formatDuration, workStatus } from '@/lib/workStatus'

const ALL_SITES = 'all'
const DAYS_IN_CHART = 7
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24]
const ATTENTION_EVENTS = ['disconnected', 'timeout', 'screen_stop', 'camera_stop']

const toast = useToast()

const sites = ref([])
const roster = ref([])
const siteFilter = ref(ALL_SITES)
const day = ref(dayjs().startOf('day'))
const search = ref('')
const events = ref([])
const initialStatuses = ref({})
const loading = ref(false)
const loadedOnce = ref(false)
const now = ref(Date.now())
let refreshTimer = null

const isToday = computed(() => day.value.isSame(dayjs(), 'day'))
const siteNames = computed(() => Object.fromEntries(sites.value.map((site) => [site.id, site.name])))
const rangeStart = computed(() => day.value.subtract(DAYS_IN_CHART - 1, 'day').startOf('day'))
const dayStart = computed(() => day.value.valueOf())
const dayEnd = computed(() => day.value.endOf('day').valueOf() + 1)

// ---- Data
async function loadRoster() {
    const response = await api.get('/live/overview')
    sites.value = response.data.data.sites
    roster.value = response.data.data.roster
    if (sites.value.length === 1) siteFilter.value = sites.value[0].id
}

async function loadActivity({ quiet = false } = {}) {
    if (!quiet) loading.value = true
    try {
        const params = {
            from: rangeStart.value.toISOString(),
            to: day.value.endOf('day').toISOString(),
            ...(siteFilter.value === ALL_SITES ? { all_sites: 1 } : { organization_id: siteFilter.value }),
        }
        const response = await api.get('/live/activity', { params })
        events.value = response.data.data.events
        initialStatuses.value = response.data.data.initial_statuses ?? {}
        now.value = Date.now()
        loadedOnce.value = true
    } catch (err) {
        if (!quiet) toast.error('Gagal memuat aktivitas', err.response?.data?.message)
    } finally {
        loading.value = false
    }
}

watch([siteFilter, day], () => loadActivity())

onMounted(async () => {
    try {
        await loadRoster()
    } catch (err) {
        toast.error('Gagal memuat daftar staf', err.response?.data?.message)
    }
    await loadActivity()
    // Hari ini: pita shift & angka terus bergerak.
    refreshTimer = setInterval(() => {
        if (!isToday.value) return
        loadActivity({ quiet: true })
        loadRoster().catch(() => {})
    }, 30_000)
})

onBeforeUnmount(() => clearInterval(refreshTimer))

// ---- Perhitungan
const segmentsByUser = computed(() =>
    buildSegments(events.value, initialStatuses.value, rangeStart.value.valueOf(), dayEnd.value, now.value),
)

// Semua staf site yang dipilih (termasuk yang belum pernah kerja), plus staf
// yang muncul di log tapi sudah tidak terdaftar.
const people = computed(() => {
    const map = new Map()
    for (const staff of roster.value) {
        if (siteFilter.value !== ALL_SITES && staff.organization_id !== siteFilter.value) continue
        map.set(staff.user_id, { id: staff.user_id, name: staff.name, siteId: staff.organization_id, status: staff.status })
    }
    for (const event of events.value) {
        if (!map.has(event.user_id)) {
            map.set(event.user_id, { id: event.user_id, name: event.user_name ?? 'Staf', siteId: event.organization_id, status: null })
        }
    }
    return [...map.values()]
})

const rows = computed(() => {
    const query = search.value.trim().toLowerCase()
    return people.value
        .filter((person) => !query || person.name.toLowerCase().includes(query))
        .map((person) => {
            const segments = clipSegments(segmentsByUser.value.get(person.id), dayStart.value, dayEnd.value)
            const totals = groupTotals(segments)
            const dayEvents = events.value.filter((e) => e.user_id === person.id && inDay(e))
            return {
                ...person,
                segments,
                totals,
                firstLogin: dayEvents.find((e) => e.type === 'login' || e.type === 'work_start')?.occurred_at ?? null,
                lastEvent: dayEvents.at(-1) ?? null,
            }
        })
        .sort((a, b) => b.totals.working - a.totals.working || a.name.localeCompare(b.name))
})

function inDay(event) {
    const at = new Date(event.occurred_at).getTime()
    return at >= dayStart.value && at < dayEnd.value
}

// Staf tanpa aktivitas di hari itu dilipat jadi satu daftar ringkas supaya
// pita tetap fokus ke yang benar-benar bekerja.
const showInactive = ref(false)
const activeRows = computed(() => rows.value.filter((row) => row.segments.length))
const inactiveRows = computed(() => rows.value.filter((row) => !row.segments.length))
const ribbonRows = computed(() => (showInactive.value ? rows.value : activeRows.value))

const dayTotals = computed(() =>
    rows.value.reduce(
        (sum, row) => {
            for (const key of Object.keys(sum)) sum[key] += row.totals[key]
            return sum
        },
        { working: 0, idle: 0, break: 0, issue: 0 },
    ),
)

const workedCount = computed(() => rows.value.filter((row) => row.totals.working > 0).length)
const workingNow = computed(() => (isToday.value ? people.value.filter((p) => p.status === 'working').length : null))
const attentionCount = computed(
    () => events.value.filter((e) => inDay(e) && (ATTENTION_EVENTS.includes(e.type) || e.status === 'alert')).length,
)

// Grafik 7 hari: jam per kelompok status untuk semua staf yang tampil.
const weekBars = computed(() => {
    const ids = new Set(rows.value.map((row) => row.id))
    return Array.from({ length: DAYS_IN_CHART }, (_, index) => {
        const date = rangeStart.value.add(index, 'day')
        const start = date.valueOf()
        const end = date.endOf('day').valueOf() + 1
        const totals = { working: 0, idle: 0, break: 0, issue: 0 }
        for (const id of ids) {
            const t = groupTotals(clipSegments(segmentsByUser.value.get(id), start, end))
            for (const key of Object.keys(totals)) totals[key] += t[key]
        }
        return { date, totals, sum: Object.values(totals).reduce((a, b) => a + b, 0) }
    })
})

const weekScaleHours = computed(() => niceCeil(Math.max(1, ...weekBars.value.map((bar) => bar.sum / 3_600_000))))

function niceCeil(value) {
    for (const step of [1, 2, 4, 5, 8, 10, 12, 16, 20, 24, 40, 50, 80, 100, 200]) if (value <= step) return step
    return Math.ceil(value / 100) * 100
}

const dayComposition = computed(() => {
    const total = Object.values(dayTotals.value).reduce((a, b) => a + b, 0)
    return CHART_GROUPS.map((group) => ({
        ...group,
        ms: dayTotals.value[group.key],
        percent: total ? (dayTotals.value[group.key] / total) * 100 : 0,
    }))
})

// ---- Pita shift: posisi & sorotan
function leftPercent(at) {
    return ((at - dayStart.value) / (dayEnd.value - dayStart.value)) * 100
}

function widthPercent(segment) {
    return Math.max(0.25, ((segment.end - segment.start) / (dayEnd.value - dayStart.value)) * 100)
}

const nowPercent = computed(() => (isToday.value ? leftPercent(now.value) : null))
const hovered = ref(null)

function describeSegment(row, segment) {
    return `${row.name} · ${workStatus(segment.status).label} ${dayjs(segment.start).format('HH:mm')}–${dayjs(segment.end).format('HH:mm')} (${formatDuration((segment.end - segment.start) / 1000)})`
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

// ---- Rincian staf
const selectedId = ref(null)
const selected = computed(() => rows.value.find((row) => row.id === selectedId.value) ?? null)

const selectedWeek = computed(() => {
    if (!selected.value) return []
    return Array.from({ length: DAYS_IN_CHART }, (_, index) => {
        const date = rangeStart.value.add(index, 'day')
        const t = groupTotals(clipSegments(segmentsByUser.value.get(selected.value.id), date.valueOf(), date.endOf('day').valueOf() + 1))
        return { date, totals: t, sum: Object.values(t).reduce((a, b) => a + b, 0) }
    })
})

const selectedWeekScale = computed(() => niceCeil(Math.max(1, ...selectedWeek.value.map((bar) => bar.sum / 3_600_000))))

const selectedEvents = computed(() =>
    selected.value
        ? events.value
              .filter((e) => e.user_id === selected.value.id && inDay(e))
              .slice()
              .reverse()
        : [],
)

// ---- Log kejadian (semua staf yang tampil, hari terpilih)
const logOpen = ref(false)
const dayLog = computed(() => {
    const ids = new Set(rows.value.map((row) => row.id))
    return events.value
        .filter((e) => ids.has(e.user_id) && inDay(e))
        .slice()
        .reverse()
})
</script>

<template>
    <div>
        <h1 class="sr-only">Aktivitas user</h1>

        <!-- Ringkasan hari terpilih -->
        <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-base-800 px-4 pt-5 pb-4 sm:px-8">
            <div class="flex flex-wrap gap-x-8 gap-y-3">
                <Readout label="Jam kerja aktual" :value="formatDuration(dayTotals.working / 1000)" led="accent" />
                <Readout label="Rata-rata / staf" :value="workedCount ? formatDuration(dayTotals.working / 1000 / workedCount) : '—'" />
                <Readout v-if="workingNow !== null" label="Working sekarang" :value="workingNow" :led="workingNow ? 'accent' : 'muted'" />
                <Readout label="Istirahat" :value="formatDuration(dayTotals.break / 1000)" />
                <Readout label="Gangguan" :value="attentionCount" :led="attentionCount ? 'warning' : 'muted'" />
            </div>
            <p class="text-[12px] text-base-500 font-semibold">
                {{ workedCount }} dari {{ people.length }} staf bekerja
            </p>
        </div>

        <div class="space-y-5 p-4 sm:p-8">
            <!-- Bilah kendali: tanggal, site, cari -->
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

                <label class="relative w-full sm:w-56">
                    <span class="sr-only">Cari staf</span>
                    <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                    <input v-model="search" type="search" placeholder="Cari staf…" class="field-control !py-2 pl-9" />
                </label>
            </div>

            <!-- Pita shift -->
            <section
                class="overflow-hidden rounded-xl border border-base-800 bg-base-900 shadow-(--shadow-card)"
                aria-labelledby="ribbon-title"
            >
                <header class="flex flex-wrap items-center justify-between gap-3 border-b border-base-800 px-5 py-3.5">
                    <div>
                        <h2 id="ribbon-title" class="font-display text-base font-bold text-base-50 tracking-[-0.015em]">Pita shift</h2>
                        <p class="mt-0.5 text-xs text-base-500">
                            Status tiap staf sepanjang hari, jam 00–24. Arahkan ke blok untuk melihat rinciannya.
                        </p>
                    </div>
                    <ul class="flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Keterangan warna">
                        <li
                            v-for="key in ['working', 'idle', 'break', 'screen_off', 'camera_off', 'disconnected', 'alert']"
                            :key="key"
                            class="flex items-center gap-1.5 text-xs text-base-400"
                        >
                            <span class="size-2.5 rounded-sm" :class="workStatus(key).bar" />
                            {{ workStatus(key).label }}
                        </li>
                    </ul>
                </header>

                <!-- Baris sorotan: rincian blok yang sedang ditunjuk -->
                <p
                    class="min-h-9 border-b border-base-800 bg-base-850/60 px-5 py-2 font-mono text-xs text-base-300 tabular-nums"
                    aria-live="polite"
                >
                    {{
                        hovered ??
                        (isToday
                            ? `Diperbarui ${dayjs(now).format('HH:mm:ss')} · otomatis tiap 30 detik`
                            : 'Pilih hari lain dengan panah di atas')
                    }}
                </p>

                <div v-if="loading && !loadedOnce" class="px-5 py-16 text-center text-sm text-base-500">Memuat aktivitas…</div>
                <div v-else-if="!rows.length" class="flex flex-col items-center gap-2 px-6 py-14 text-center">
                    <span class="flex size-11 items-center justify-center rounded-xl bg-base-850 text-base-400"
                        ><UserRound class="size-5"
                    /></span>
                    <p class="font-medium text-base-100">{{ search ? 'Tidak ada staf yang cocok' : 'Belum ada staf di site ini' }}</p>
                    <p class="max-w-sm text-sm text-base-500">Staf yang boleh Live Kerja muncul di sini, lengkap dengan jam kerjanya.</p>
                </div>
                <div v-else class="px-5 py-3">
                    <!-- Sumbu jam -->
                    <div
                        class="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_4.5rem] items-end gap-3 max-sm:grid-cols-[minmax(0,1fr)_4rem]"
                    >
                        <span class="max-sm:hidden" />
                        <div class="relative h-5 max-sm:col-span-2" aria-hidden="true">
                            <span
                                v-for="hour in HOUR_TICKS"
                                :key="hour"
                                class="absolute -translate-x-1/2 font-mono text-[10px] text-base-500 tabular-nums first:translate-x-0 last:-translate-x-full"
                                :style="{ left: `${(hour / 24) * 100}%` }"
                            >
                                {{ String(hour).padStart(2, '0') }}
                            </span>
                        </div>
                        <span class="text-right text-[11px] text-base-500 max-sm:hidden font-semibold">Kerja</span>
                    </div>

                    <button
                        v-for="row in ribbonRows"
                        :key="row.id"
                        type="button"
                        class="group grid w-full grid-cols-[minmax(0,10rem)_minmax(0,1fr)_4.5rem] items-center gap-3 rounded-lg py-1.5 text-left transition-colors hover:bg-base-850/70 focus-visible:outline-2 focus-visible:outline-accent-400 max-sm:grid-cols-[minmax(0,1fr)_4rem] max-sm:gap-y-1"
                        :aria-label="`Rincian aktivitas ${row.name}`"
                        @click="selectedId = row.id"
                    >
                        <span class="min-w-0 pl-1">
                            <span class="flex items-center gap-2">
                                <span class="led" :class="row.status ? workStatus(row.status).led : 'text-base-500 led-off'" />
                                <span class="truncate text-sm font-medium text-base-100 group-hover:text-base-50">{{ row.name }}</span>
                            </span>
                            <span v-if="siteFilter === ALL_SITES" class="block truncate pl-3.5 text-[11px] text-base-500">{{
                                siteNames[row.siteId]
                            }}</span>
                        </span>
                        <span class="relative h-6 overflow-hidden rounded-md bg-base-850 max-sm:order-3 max-sm:col-span-2">
                            <span
                                v-for="hour in HOUR_TICKS.slice(1, -1)"
                                :key="hour"
                                class="absolute inset-y-0 w-px bg-base-800"
                                :style="{ left: `${(hour / 24) * 100}%` }"
                                aria-hidden="true"
                            />
                            <span
                                v-for="segment in row.segments"
                                :key="segment.start"
                                class="absolute inset-y-1 rounded-sm transition-opacity hover:opacity-80"
                                :class="workStatus(segment.status).bar"
                                :style="{ left: `${leftPercent(segment.start)}%`, width: `${widthPercent(segment)}%` }"
                                :title="describeSegment(row, segment)"
                                @mouseenter="hovered = describeSegment(row, segment)"
                                @mouseleave="hovered = null"
                            />
                            <span
                                v-if="nowPercent !== null"
                                class="absolute inset-y-0 w-0.5 bg-danger-400"
                                :style="{ left: `${nowPercent}%` }"
                                aria-hidden="true"
                            />
                        </span>
                        <span class="text-right font-mono text-sm text-base-50 tabular-nums">{{
                            formatDuration(row.totals.working / 1000)
                        }}</span>
                    </button>

                    <div
                        v-if="inactiveRows.length"
                        class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-dashed border-base-800 pt-3"
                    >
                        <p class="text-xs text-base-500">
                            <span class="font-medium text-base-300">{{ inactiveRows.length }} staf</span> tanpa aktivitas
                            {{ dayLabel.toLowerCase()
                            }}<template v-if="!showInactive"
                                >:
                                {{
                                    inactiveRows
                                        .slice(0, 6)
                                        .map((row) => row.name)
                                        .join(', ')
                                }}{{ inactiveRows.length > 6 ? ', …' : '' }}</template
                            >
                        </p>
                        <BaseButton variant="ghost" size="sm" @click="showInactive = !showInactive">
                            {{ showInactive ? 'Sembunyikan dari pita' : 'Tampilkan di pita' }}
                        </BaseButton>
                    </div>
                </div>
            </section>

            <div class="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <!-- Grafik 7 hari -->
                <section class="rounded-xl border border-base-800 bg-base-900 p-5 shadow-(--shadow-card)" aria-labelledby="week-title">
                    <h2 id="week-title" class="font-display text-base font-bold text-base-50 tracking-[-0.015em]">Jam kerja 7 hari</h2>
                    <p class="mt-0.5 text-xs text-base-500">Total semua staf yang tampil, per hari. Klik batang untuk membuka hari itu.</p>

                    <div class="mt-5 flex gap-3">
                        <div
                            class="flex h-48 flex-col justify-between py-0.5 text-right font-mono text-[10px] text-base-500 tabular-nums"
                            aria-hidden="true"
                        >
                            <span>{{ weekScaleHours }}j</span>
                            <span>{{ weekScaleHours / 2 }}j</span>
                            <span>0</span>
                        </div>
                        <div class="relative grid h-48 flex-1 grid-cols-7 items-end gap-2 border-b border-base-700">
                            <span class="absolute inset-x-0 top-0 border-t border-dashed border-base-800" aria-hidden="true" />
                            <span class="absolute inset-x-0 top-1/2 border-t border-dashed border-base-800" aria-hidden="true" />
                            <button
                                v-for="bar in weekBars"
                                :key="bar.date.valueOf()"
                                type="button"
                                class="relative z-10 flex h-full flex-col-reverse overflow-hidden rounded-t-md focus-visible:outline-2 focus-visible:outline-accent-400"
                                :class="
                                    bar.date.isSame(day, 'day')
                                        ? 'ring-2 ring-accent-400/60 ring-offset-2 ring-offset-base-900'
                                        : 'opacity-80 hover:opacity-100'
                                "
                                :aria-label="`${bar.date.format('dddd D MMMM')}: kerja ${formatDuration(bar.totals.working / 1000)}`"
                                :title="`${bar.date.format('ddd D MMM')} · kerja ${formatDuration(bar.totals.working / 1000)}, istirahat ${formatDuration(bar.totals.break / 1000)}, idle ${formatDuration(bar.totals.idle / 1000)}, bermasalah ${formatDuration(bar.totals.issue / 1000)}`"
                                @click="day = bar.date.startOf('day')"
                            >
                                <span
                                    v-for="group in CHART_GROUPS"
                                    :key="group.key"
                                    :class="group.bar"
                                    :style="{ height: `${(bar.totals[group.key] / 3_600_000 / weekScaleHours) * 100}%` }"
                                />
                            </button>
                        </div>
                    </div>
                    <div class="mt-2 ml-9 grid grid-cols-7 gap-2 text-center">
                        <span
                            v-for="bar in weekBars"
                            :key="bar.date.valueOf()"
                            class="font-mono text-[10.5px] tabular-nums"
                            :class="bar.date.isSame(day, 'day') ? 'font-semibold text-base-50' : 'text-base-500'"
                        >
                            {{ bar.date.format('dd D') }}
                        </span>
                    </div>
                    <ul class="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
                        <li v-for="group in CHART_GROUPS" :key="group.key" class="flex items-center gap-1.5 text-xs text-base-400">
                            <span class="size-2.5 rounded-sm" :class="group.bar" />{{ group.label }}
                        </li>
                    </ul>
                </section>

                <!-- Komposisi waktu hari terpilih -->
                <section class="rounded-xl border border-base-800 bg-base-900 p-5 shadow-(--shadow-card)" aria-labelledby="mix-title">
                    <h2 id="mix-title" class="font-display text-base font-bold text-base-50 tracking-[-0.015em]">
                        Komposisi waktu · {{ dayLabel.toLowerCase() }}
                    </h2>
                    <p class="mt-0.5 text-xs text-base-500">Ke mana jam staf yang sedang live terpakai. Offline tidak dihitung.</p>

                    <div
                        class="mt-5 flex h-4 overflow-hidden rounded-full bg-base-850"
                        role="img"
                        :aria-label="dayComposition.map((g) => `${g.label} ${Math.round(g.percent)}%`).join(', ')"
                    >
                        <span v-for="group in dayComposition" :key="group.key" :class="group.bar" :style="{ width: `${group.percent}%` }" />
                    </div>

                    <dl class="mt-5 space-y-3">
                        <div v-for="group in dayComposition" :key="group.key" class="flex items-center gap-3">
                            <span class="size-2.5 shrink-0 rounded-sm" :class="group.bar" />
                            <dt class="flex-1 text-sm text-base-300">{{ group.label }}</dt>
                            <dd class="font-mono text-sm text-base-50 tabular-nums">{{ formatDuration(group.ms / 1000) }}</dd>
                            <dd class="w-12 text-right font-mono text-xs text-base-500 tabular-nums">{{ Math.round(group.percent) }}%</dd>
                        </div>
                    </dl>
                </section>
            </div>

            <!-- Log kejadian mentah -->
            <section class="overflow-hidden rounded-xl border border-base-800 bg-base-900 shadow-(--shadow-card)">
                <button
                    type="button"
                    class="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-base-850/60 focus-visible:outline-2 focus-visible:outline-accent-400"
                    :aria-expanded="logOpen"
                    @click="logOpen = !logOpen"
                >
                    <span>
                        <span class="font-display text-base font-bold text-base-50 tracking-[-0.015em]">Log kejadian</span>
                        <span class="ml-2 font-mono text-xs text-base-500 tabular-nums">{{ dayLog.length }}</span>
                        <span class="mt-0.5 block text-xs text-base-500"
                            >Login, mulai kerja, layar & kamera, istirahat, terputus, logout — terbaru di atas.</span
                        >
                    </span>
                    <ChevronDown class="size-4 text-base-400 transition-transform" :class="logOpen && 'rotate-180'" />
                </button>
                <div v-if="logOpen" class="max-h-[32rem] overflow-auto border-t border-base-800">
                    <p v-if="!dayLog.length" class="px-5 py-8 text-center text-sm text-base-500">Tidak ada kejadian di hari ini.</p>
                    <table v-else class="data-table">
                        <thead class="sticky top-0 bg-base-900">
                            <tr>
                                <th>Waktu</th>
                                <th>Staf</th>
                                <th>Aktivitas</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="event in dayLog" :key="event.id">
                                <td class="font-mono text-base-300 tabular-nums">{{ dayjs(event.occurred_at).format('HH:mm:ss') }}</td>
                                <td class="text-base-100">{{ event.user_name }}</td>
                                <td class="text-base-100">{{ WORK_EVENT_LABELS[event.type] ?? event.type }}</td>
                                <td>
                                    <span
                                        class="inline-flex items-center gap-1.5 text-[11px] text-base-300 font-semibold"
                                    >
                                        {{ workStatus(event.status).emoji }} {{ workStatus(event.status).label }}
                                    </span>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>
        </div>

        <!-- Rincian satu staf (panel samping) -->
        <DialogRoot :open="!!selected" @update:open="(v) => !v && (selectedId = null)">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-base-950/60 backdrop-blur-sm" />
                <DialogContent
                    class="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-base-800 bg-base-900 shadow-(--shadow-raised) focus:outline-none"
                >
                    <template v-if="selected">
                        <header class="flex items-start gap-3 border-b border-base-800 px-5 py-4">
                            <div class="min-w-0 flex-1">
                                <DialogTitle class="truncate font-display text-xl font-bold text-base-50 tracking-[-0.015em]">{{
                                    selected.name
                                }}</DialogTitle>
                                <DialogDescription class="mt-1 flex flex-wrap items-center gap-2 text-xs text-base-400">
                                    <span>{{ siteNames[selected.siteId] ?? 'Site' }}</span>
                                    <span
                                        v-if="selected.status"
                                        class="inline-flex items-center gap-1.5 rounded-full border px-1.5 py-0.5 text-[11px] font-semibold"
                                        :class="workStatus(selected.status).chip"
                                    >
                                        <span class="led" :class="workStatus(selected.status).led" />{{ workStatus(selected.status).label }}
                                    </span>
                                </DialogDescription>
                            </div>
                            <BaseButton variant="ghost" size="icon" aria-label="Tutup" @click="selectedId = null"
                                ><X class="size-5"
                            /></BaseButton>
                        </header>

                        <div class="flex-1 space-y-6 overflow-y-auto px-5 py-5">
                            <dl class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-base-800 bg-base-800 text-sm">
                                <div class="bg-base-900 px-3 py-2.5">
                                    <dt class="eyebrow">Kerja aktual</dt>
                                    <dd class="mt-1 font-mono text-lg text-base-50 tabular-nums">
                                        {{ formatDuration(selected.totals.working / 1000) }}
                                    </dd>
                                </div>
                                <div class="bg-base-900 px-3 py-2.5">
                                    <dt class="eyebrow">Istirahat</dt>
                                    <dd class="mt-1 font-mono text-lg text-base-50 tabular-nums">
                                        {{ formatDuration(selected.totals.break / 1000) }}
                                    </dd>
                                </div>
                                <div class="bg-base-900 px-3 py-2.5">
                                    <dt class="eyebrow">Mulai</dt>
                                    <dd class="mt-1 font-mono text-base-50 tabular-nums">
                                        {{ selected.firstLogin ? dayjs(selected.firstLogin).format('HH:mm') : '—' }}
                                    </dd>
                                </div>
                                <div class="bg-base-900 px-3 py-2.5">
                                    <dt class="eyebrow">Terakhir</dt>
                                    <dd class="mt-1 truncate text-base-50">
                                        <template v-if="selected.lastEvent">
                                            <span class="font-mono tabular-nums">{{
                                                dayjs(selected.lastEvent.occurred_at).format('HH:mm')
                                            }}</span>
                                            · {{ WORK_EVENT_LABELS[selected.lastEvent.type] ?? selected.lastEvent.type }}
                                        </template>
                                        <template v-else>—</template>
                                    </dd>
                                </div>
                            </dl>

                            <div>
                                <p class="eyebrow mb-2">{{ dayLabel }}</p>
                                <div class="relative h-7 overflow-hidden rounded-md bg-base-850">
                                    <span
                                        v-for="segment in selected.segments"
                                        :key="segment.start"
                                        class="absolute inset-y-1 rounded-sm"
                                        :class="workStatus(segment.status).bar"
                                        :style="{ left: `${leftPercent(segment.start)}%`, width: `${widthPercent(segment)}%` }"
                                        :title="describeSegment(selected, segment)"
                                    />
                                    <span
                                        v-if="nowPercent !== null"
                                        class="absolute inset-y-0 w-0.5 bg-danger-400"
                                        :style="{ left: `${nowPercent}%` }"
                                    />
                                </div>
                                <div class="mt-1 flex justify-between font-mono text-[10px] text-base-500">
                                    <span>00</span><span>12</span><span>24</span>
                                </div>
                            </div>

                            <div>
                                <p class="eyebrow mb-3">7 hari terakhir</p>
                                <div class="flex h-28 items-end gap-2 border-b border-base-700">
                                    <div
                                        v-for="bar in selectedWeek"
                                        :key="bar.date.valueOf()"
                                        class="flex h-full flex-1 flex-col-reverse overflow-hidden rounded-t"
                                        :title="`${bar.date.format('ddd D MMM')} · kerja ${formatDuration(bar.totals.working / 1000)}`"
                                    >
                                        <span
                                            v-for="group in CHART_GROUPS"
                                            :key="group.key"
                                            :class="group.bar"
                                            :style="{ height: `${(bar.totals[group.key] / 3_600_000 / selectedWeekScale) * 100}%` }"
                                        />
                                    </div>
                                </div>
                                <div class="mt-1.5 flex gap-2 text-center">
                                    <span
                                        v-for="bar in selectedWeek"
                                        :key="bar.date.valueOf()"
                                        class="flex-1 font-mono text-[10px] text-base-500"
                                    >
                                        {{ bar.date.format('dd') }}
                                    </span>
                                </div>
                            </div>

                            <div>
                                <p class="eyebrow mb-2">Kejadian {{ dayLabel.toLowerCase() }}</p>
                                <p v-if="!selectedEvents.length" class="text-sm text-base-500">Tidak ada kejadian.</p>
                                <ol v-else class="relative space-y-3 border-l border-base-800 pl-4">
                                    <li v-for="event in selectedEvents" :key="event.id" class="relative">
                                        <span
                                            class="absolute top-1.5 -left-[1.3rem] size-2 rounded-full ring-4 ring-base-900"
                                            :class="workStatus(event.status).bar"
                                        />
                                        <p class="text-sm text-base-100">{{ WORK_EVENT_LABELS[event.type] ?? event.type }}</p>
                                        <p class="font-mono text-[11px] text-base-500 tabular-nums">
                                            {{ dayjs(event.occurred_at).format('HH:mm:ss') }} · {{ workStatus(event.status).label }}
                                        </p>
                                    </li>
                                </ol>
                            </div>
                        </div>
                    </template>
                </DialogContent>
            </DialogPortal>
        </DialogRoot>
    </div>
</template>
