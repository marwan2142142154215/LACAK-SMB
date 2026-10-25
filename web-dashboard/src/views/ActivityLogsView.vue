<script setup>
import {
    Building2,
    ChevronDown,
    Database,
    Download,
    Lock,
    LogIn,
    MapPinned,
    PackageOpen,
    Search,
    Send,
    Settings,
    Smartphone,
    Users,
} from '@lucide/vue'
import dayjs from 'dayjs'
import { computed, onMounted, ref, watch } from 'vue'

import BaseButton from '@/components/ui/BaseButton.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

// Kategori -- kunci sama dengan RecordApiActivity di backend.
const CATEGORIES = {
    auth: { label: 'Login & akun', icon: LogIn, tone: 'text-st-break bg-st-break/10' },
    staf: { label: 'Staf', icon: Users, tone: 'text-accent-400 bg-accent-500/10' },
    device: { label: 'Device', icon: Smartphone, tone: 'text-copper-400 bg-copper-400/10' },
    perintah: { label: 'Perintah device', icon: Lock, tone: 'text-danger-400 bg-danger-500/10' },
    aturan: { label: 'Aturan & consent', icon: MapPinned, tone: 'text-st-camera bg-st-camera/10' },
    apk: { label: 'Build APK', icon: PackageOpen, tone: 'text-st-idle bg-st-idle/10' },
    telegram: { label: 'Telegram', icon: Send, tone: 'text-st-break bg-st-break/10' },
    site: { label: 'Site', icon: Building2, tone: 'text-base-300 bg-base-800' },
    pengaturan: { label: 'Pengaturan', icon: Settings, tone: 'text-danger-400 bg-danger-500/10' },
    data: { label: 'Perubahan data', icon: Database, tone: 'text-base-300 bg-base-800' },
}

const RESULTS = {
    ok: { label: 'Berhasil', chip: 'border-st-working/30 bg-st-working/10 text-st-working' },
    denied: { label: 'Ditolak', chip: 'border-st-idle/30 bg-st-idle/10 text-st-idle' },
    failed: { label: 'Gagal', chip: 'border-danger-500/30 bg-danger-500/10 text-danger-400' },
}

const PERIODS = [
    { key: 'today', label: 'Hari ini', from: () => dayjs().startOf('day') },
    { key: '7d', label: '7 hari', from: () => dayjs().subtract(6, 'day').startOf('day') },
    { key: '30d', label: '30 hari', from: () => dayjs().subtract(29, 'day').startOf('day') },
    { key: 'all', label: 'Semua', from: () => null },
]

// Nama kolom data yang lebih mudah dibaca di rincian perubahan.
const FIELD_LABELS = {
    username: 'Username',
    email: 'Email',
    name: 'Nama',
    is_active: 'Aktif',
    device_name: 'Nama device',
    status: 'Status',
    rule_name: 'Nama aturan',
    allowed_ssid: 'SSID WiFi',
    allowed_ip_cidr: 'IP / CIDR',
    max_distance_meters: 'Radius (m)',
    center_latitude: 'Latitude',
    center_longitude: 'Longitude',
    subject_name: 'Pemegang device',
    signer_name: 'Penandatangan',
    signer_role: 'Jabatan',
    revoked_at: 'Dicabut',
    type: 'Jenis',
    unique_site_code: 'Kode site',
    value: 'Nilai',
    role: 'Peran',
    organization_id: 'Site',
    command_type: 'Perintah',
    issued_via: 'Lewat',
    reason_note: 'Alasan',
    apk_type: 'Jenis paket',
    version: 'Versi',
    telegram_chat_id: 'Chat ID',
    telegram_user_id: 'ID Telegram',
    two_factor_required: '2FA wajib',
    organization_ids: 'Site',
    client: 'Aplikasi',
}

const auth = useAuthStore()
const toast = useToast()

const sites = ref([])
const siteId = ref('all')
const period = ref('7d')
const category = ref('')
const result = ref('')
const search = ref('')
const entries = ref([])
const hasMore = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const expanded = ref(new Set())
let searchTimer = null
let requestSeq = 0

const counts = computed(() => ({
    ok: entries.value.filter((entry) => entry.result === 'ok').length,
    denied: entries.value.filter((entry) => entry.result === 'denied').length,
    failed: entries.value.filter((entry) => entry.result === 'failed').length,
}))

// Dikelompokkan per hari, terbaru di atas.
const groups = computed(() => {
    const result = []
    for (const entry of entries.value) {
        const day = dayjs(entry.at)
        const key = day.format('YYYY-MM-DD')
        let group = result.at(-1)
        if (!group || group.key !== key) {
            group = { key, label: dayLabel(day), entries: [] }
            result.push(group)
        }
        group.entries.push(entry)
    }
    return result
})

function dayLabel(day) {
    if (day.isSame(dayjs(), 'day')) return 'Hari ini'
    if (day.isSame(dayjs().subtract(1, 'day'), 'day')) return 'Kemarin'
    return day.format('dddd, D MMMM YYYY')
}

function params(beforeId) {
    const from = PERIODS.find((item) => item.key === period.value)?.from()
    return {
        organization_id: siteId.value === 'all' ? undefined : siteId.value,
        from: from?.toISOString(),
        category: category.value || undefined,
        result: result.value || undefined,
        search: search.value.trim() || undefined,
        before_id: beforeId,
    }
}

async function load() {
    const seq = ++requestSeq
    loading.value = true
    try {
        const response = await api.get('/activity-logs', { params: params() })
        if (seq !== requestSeq) return // filter sudah berubah lagi
        entries.value = response.data.data.entries
        hasMore.value = response.data.data.has_more
        expanded.value = new Set()
    } catch (err) {
        if (seq === requestSeq) toast.error('Gagal memuat log aktivitas', err.response?.data?.message)
    } finally {
        if (seq === requestSeq) loading.value = false
    }
}

async function loadMore() {
    loadingMore.value = true
    try {
        const response = await api.get('/activity-logs', { params: params(entries.value.at(-1)?.id) })
        entries.value = [...entries.value, ...response.data.data.entries]
        hasMore.value = response.data.data.has_more
    } catch (err) {
        toast.error('Gagal memuat log aktivitas', err.response?.data?.message)
    } finally {
        loadingMore.value = false
    }
}

watch([siteId, period, category, result], load)
watch(search, () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(load, 350)
})

function toggle(id) {
    const next = new Set(expanded.value)
    next.has(id) ? next.delete(id) : next.add(id)
    expanded.value = next
}

function hasDetail(entry) {
    return entry.changes.length || Object.keys(entry.input ?? {}).length || entry.message || entry.user_agent
}

function formatValue(value) {
    if (value === null || value === undefined || value === '') return '—'
    if (value === true) return 'Ya'
    if (value === false) return 'Tidak'
    if (Array.isArray(value)) return value.join(', ')
    if (typeof value === 'object') return JSON.stringify(value)
    // Tanggal ISO dari kolom timestamp
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return dayjs(value).format('D MMM YYYY HH:mm')
    return String(value)
}

const eventLabel = { created: 'dibuat', updated: 'diubah', deleted: 'dihapus' }

// Unduh baris yang sedang tampil (sesuai filter) sebagai CSV untuk arsip / laporan.
function exportCsv() {
    const rows = [['Waktu', 'Kategori', 'Aktivitas', 'Hasil', 'Pengguna', 'Username', 'Site', 'IP', 'Perangkat']]
    for (const entry of entries.value) {
        rows.push([
            dayjs(entry.at).format('YYYY-MM-DD HH:mm:ss'),
            CATEGORIES[entry.category]?.label ?? entry.category,
            entry.description,
            RESULTS[entry.result]?.label ?? entry.result,
            entry.causer?.name ?? (entry.category === 'auth' ? 'Tidak dikenal' : 'Sistem'),
            entry.causer?.username ?? '',
            entry.organization?.name ?? '',
            entry.ip_address ?? '',
            entry.device ?? '',
        ])
    }
    const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n')
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
    link.download = `log-aktivitas-${dayjs().format('YYYYMMDD-HHmm')}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
}

onMounted(async () => {
    try {
        sites.value = (await api.get('/live/sites')).data.data
    } catch {
        sites.value = []
    }
    if (!auth.isSuperAdmin && auth.user?.organization_id) siteId.value = auth.user.organization_id
    load()
})
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Akses"
            title="Log aktivitas"
            subtitle="Siapa melakukan apa di sistem: login, perubahan staf, perintah ke device, aturan, build APK, dan pengaturan — termasuk aksi yang ditolak. Jam kerja staf ada di menu Aktivitas user."
        >
            <template #actions>
                <BaseButton variant="outline" size="sm" :disabled="!entries.length" @click="exportCsv">
                    <Download class="size-4" />
                    Unduh CSV
                </BaseButton>
            </template>
            <template #readouts>
                <Readout label="Ditampilkan" :value="loading ? '…' : `${entries.length}${hasMore ? '+' : ''}`" />
                <Readout label="Berhasil" :value="counts.ok" led="accent" />
                <Readout label="Ditolak" :value="counts.denied" :led="counts.denied ? 'warning' : 'muted'" />
                <Readout label="Gagal" :value="counts.failed" :led="counts.failed ? 'danger' : 'muted'" />
            </template>
        </PageHeader>

        <div class="grid gap-4 p-4 sm:p-8">
            <!-- Saringan -->
            <div class="grid gap-3 rounded-xl border border-base-800 bg-base-900 p-3 shadow-(--shadow-card)">
                <div class="flex flex-wrap items-center gap-2">
                    <div class="flex rounded-lg border border-base-800 bg-base-850 p-0.5" role="radiogroup" aria-label="Periode">
                        <button
                            v-for="item in PERIODS"
                            :key="item.key"
                            type="button"
                            role="radio"
                            :aria-checked="period === item.key"
                            class="rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent-400"
                            :class="
                                period === item.key
                                    ? 'bg-base-900 text-base-50 shadow-(--shadow-card)'
                                    : 'text-base-400 hover:text-base-100'
                            "
                            @click="period = item.key"
                        >
                            {{ item.label }}
                        </button>
                    </div>

                    <label v-if="sites.length > 1" class="relative">
                        <span class="sr-only">Site</span>
                        <select v-model="siteId" class="field-control h-9 appearance-none py-0 pr-8 text-sm">
                            <option value="all">Semua site</option>
                            <option v-for="site in sites" :key="site.id" :value="site.id">{{ site.name }}</option>
                        </select>
                        <ChevronDown class="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-base-500" />
                    </label>

                    <label class="relative">
                        <span class="sr-only">Hasil</span>
                        <select v-model="result" class="field-control h-9 appearance-none py-0 pr-8 text-sm">
                            <option value="">Semua hasil</option>
                            <option v-for="(meta, key) in RESULTS" :key="key" :value="key">{{ meta.label }}</option>
                        </select>
                        <ChevronDown class="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-base-500" />
                    </label>

                    <label class="relative min-w-52 flex-1">
                        <span class="sr-only">Cari</span>
                        <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                        <input
                            v-model="search"
                            type="search"
                            placeholder="Cari aktivitas, nama staf, atau IP…"
                            class="field-control h-9 pl-9 text-sm"
                        />
                    </label>
                </div>

                <div class="-m-0.5 flex gap-1 overflow-x-auto p-0.5" role="radiogroup" aria-label="Kategori">
                    <button
                        type="button"
                        role="radio"
                        :aria-checked="category === ''"
                        class="shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors"
                        :class="
                            category === ''
                                ? 'border-accent-500 bg-accent-500 text-base-950'
                                : 'border-base-800 text-base-400 hover:text-base-100'
                        "
                        @click="category = ''"
                    >
                        Semua
                    </button>
                    <button
                        v-for="(meta, key) in CATEGORIES"
                        :key="key"
                        type="button"
                        role="radio"
                        :aria-checked="category === key"
                        class="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors"
                        :class="
                            category === key
                                ? 'border-accent-500 bg-accent-500 text-base-950'
                                : 'border-base-800 text-base-400 hover:text-base-100'
                        "
                        @click="category = key"
                    >
                        <component :is="meta.icon" class="size-3.5" />
                        {{ meta.label }}
                    </button>
                </div>
            </div>

            <!-- Daftar -->
            <div v-if="loading && !entries.length" class="grid gap-2">
                <div v-for="n in 6" :key="n" class="h-16 animate-pulse rounded-xl border border-base-800 bg-base-900" />
            </div>

            <div
                v-else-if="!entries.length"
                class="rounded-xl border border-dashed border-base-800 px-6 py-14 text-center text-sm text-base-500"
            >
                Belum ada aktivitas yang cocok dengan saringan ini.
            </div>

            <section v-for="group in groups" :key="group.key" class="grid gap-2" :class="loading && 'opacity-60'">
                <h2 class="eyebrow mt-2">{{ group.label }}</h2>
                <ol class="overflow-hidden rounded-xl border border-base-800 bg-base-900 shadow-(--shadow-card)">
                    <li v-for="entry in group.entries" :key="entry.id" class="border-b border-base-800 last:border-b-0">
                        <button
                            type="button"
                            class="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-base-850/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-400"
                            :aria-expanded="expanded.has(entry.id)"
                            :disabled="!hasDetail(entry)"
                            @click="toggle(entry.id)"
                        >
                            <time class="w-12 shrink-0 pt-0.5 font-mono text-xs text-base-500 tabular-nums" :datetime="entry.at">
                                {{ dayjs(entry.at).format('HH:mm') }}
                            </time>
                            <span
                                class="flex size-8 shrink-0 items-center justify-center rounded-lg"
                                :class="CATEGORIES[entry.category]?.tone ?? 'bg-base-800 text-base-300'"
                                :title="CATEGORIES[entry.category]?.label"
                            >
                                <component :is="CATEGORIES[entry.category]?.icon ?? Database" class="size-4" />
                            </span>
                            <div class="min-w-0 flex-1">
                                <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-base-50">
                                    <span class="font-medium [overflow-wrap:anywhere]">{{ entry.description }}</span>
                                    <span
                                        v-if="entry.result !== 'ok'"
                                        class="rounded-full border px-1.5 py-px text-[11px] font-semibold"
                                        :class="RESULTS[entry.result]?.chip"
                                    >
                                        {{ RESULTS[entry.result]?.label }}
                                    </span>
                                </p>
                                <p class="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-base-500">
                                    <span class="text-base-300">
                                        {{ entry.causer?.name ?? (entry.category === 'auth' ? 'Tidak dikenal' : 'Sistem') }}
                                        <span v-if="entry.causer?.username" class="font-mono text-base-500"
                                            >@{{ entry.causer.username }}</span
                                        >
                                    </span>
                                    <span v-if="entry.organization?.name">{{ entry.organization.name }}</span>
                                    <span v-if="entry.device || entry.ip_address" class="font-mono">
                                        {{ [entry.device, entry.ip_address].filter(Boolean).join(' · ') }}
                                    </span>
                                </p>
                            </div>
                            <ChevronDown
                                v-if="hasDetail(entry)"
                                class="mt-1.5 size-4 shrink-0 text-base-500 transition-transform"
                                :class="expanded.has(entry.id) && 'rotate-180'"
                            />
                        </button>

                        <!-- Rincian -->
                        <div
                            v-if="expanded.has(entry.id)"
                            class="grid gap-3 bg-base-850/40 px-4 pt-1 pb-4 pl-[5.75rem] text-xs max-sm:pl-4"
                        >
                            <p v-if="entry.message" class="rounded-md bg-base-900 px-3 py-2 text-base-300">
                                <span class="font-medium text-base-100">Alasan:</span> {{ entry.message }}
                                <span v-if="entry.status" class="font-mono text-base-500"> (HTTP {{ entry.status }})</span>
                            </p>

                            <div
                                v-for="(change, index) in entry.changes"
                                :key="index"
                                class="overflow-hidden rounded-md border border-base-800 bg-base-900"
                            >
                                <p class="border-b border-base-800 px-3 py-1.5 text-base-300">
                                    {{ change.type }} <span class="font-medium text-base-100">{{ change.name }}</span>
                                    {{ eventLabel[change.event] ?? change.event }}
                                </p>
                                <table v-if="change.fields.length" class="w-full">
                                    <tbody>
                                        <tr
                                            v-for="field in change.fields"
                                            :key="field.field"
                                            class="border-b border-base-800 last:border-b-0"
                                        >
                                            <th class="w-36 px-3 py-1.5 text-left font-normal text-base-500">
                                                {{ FIELD_LABELS[field.field] ?? field.field }}
                                            </th>
                                            <td class="px-3 py-1.5 font-mono text-base-400 line-through decoration-base-600">
                                                <template v-if="change.event !== 'created'">{{ formatValue(field.old) }}</template>
                                            </td>
                                            <td class="px-1 text-base-600">→</td>
                                            <td class="px-3 py-1.5 font-mono text-base-100">
                                                {{ change.event === 'deleted' ? '—' : formatValue(field.new) }}
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>

                            <dl v-if="Object.keys(entry.input ?? {}).length" class="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1">
                                <template v-for="(value, key) in entry.input" :key="key">
                                    <dt class="text-base-500">{{ FIELD_LABELS[key] ?? key }}</dt>
                                    <dd class="font-mono text-base-200 [overflow-wrap:anywhere]">{{ formatValue(value) }}</dd>
                                </template>
                            </dl>

                            <p v-if="entry.user_agent" class="font-mono text-[11px] text-base-500 [overflow-wrap:anywhere]">
                                {{ dayjs(entry.at).format('D MMM YYYY HH:mm:ss') }} · {{ entry.route }} · {{ entry.user_agent }}
                            </p>
                        </div>
                    </li>
                </ol>
            </section>

            <div v-if="hasMore" class="text-center">
                <BaseButton variant="outline" size="sm" :loading="loadingMore" @click="loadMore"> Muat lebih banyak </BaseButton>
            </div>
        </div>
    </div>
</template>
