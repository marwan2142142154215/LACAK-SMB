<script setup>
import {
    Clock,
    Cpu,
    Database,
    HardDrive,
    ListChecks,
    MemoryStick,
    MessagesSquare,
    RefreshCw,
    Server,
    TimerReset,
    Video,
    Zap,
} from '@lucide/vue'
import dayjs from 'dayjs'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
import { useNow } from '@/composables/useNow'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'

// Diperiksa ulang tiap 15 detik selama halaman terbuka.
const REFRESH_MS = 15_000
const HISTORY_LENGTH = 40

const STATUS = {
    ok: { label: 'Normal', chip: 'border-st-working/30 bg-st-working/10 text-st-working', led: 'text-st-working', bar: 'bg-st-working' },
    warn: { label: 'Perlu dicek', chip: 'border-st-idle/30 bg-st-idle/10 text-st-idle', led: 'text-st-idle', bar: 'bg-st-idle' },
    down: { label: 'Mati', chip: 'border-danger-500/30 bg-danger-500/10 text-danger-400', led: 'text-danger-400', bar: 'bg-danger-400' },
    unknown: {
        label: 'Belum diketahui',
        chip: 'border-base-700 bg-base-850 text-base-400',
        led: 'text-base-500 led-off',
        bar: 'bg-base-700',
    },
}

const ICONS = {
    api: Server,
    database: Database,
    cache: Zap,
    scheduler: TimerReset,
    queue: ListChecks,
    gateway: MessagesSquare,
    livekit: Video,
    storage: HardDrive,
}

// Apa akibatnya bagi pengguna kalau layanan ini mati -- membantu admin
// memutuskan mana yang harus dibereskan dulu.
const IMPACT = {
    api: 'Dashboard & semua aplikasi tidak bisa dipakai.',
    database: 'Semua data tidak bisa dibaca/disimpan.',
    cache: 'Login & pengaturan bisa gagal.',
    scheduler: 'Sesi Live Kerja yang terputus tidak ditutup otomatis.',
    queue: 'Build APK tidak berjalan.',
    gateway: 'Chat, radar, dan perintah device tidak realtime.',
    livekit: 'Live Kerja tidak bisa menyiarkan/menonton.',
    storage: 'Unggahan & build APK bisa gagal saat disk penuh.',
}

const toast = useToast()
const now = useNow()

const snapshot = ref(null)
const loading = ref(false)
const failed = ref(false)
// Riwayat hasil pemeriksaan selama halaman ini terbuka (paling baru di kanan).
const history = ref([])
let timer = null

const meta = (status) => STATUS[status] ?? STATUS.unknown
const services = computed(() => snapshot.value?.services ?? [])
const problems = computed(() => services.value.filter((service) => service.status === 'down' || service.status === 'warn'))
const okCount = computed(() => services.value.filter((service) => service.status === 'ok').length)
const units = computed(() => snapshot.value?.units ?? [])
const system = computed(() => snapshot.value?.system ?? null)

const overall = computed(() => {
    if (failed.value) return { status: 'down', title: 'Server tidak menjawab', text: 'API backend tidak bisa dihubungi dari browser ini.' }
    if (!snapshot.value) return { status: 'unknown', title: 'Memeriksa server…', text: '' }
    const status = snapshot.value.overall
    if (status === 'ok')
        return { status, title: 'Semua layanan berjalan normal', text: `${okCount.value} layanan diperiksa tanpa masalah.` }
    const names = problems.value.map((service) => service.name).join(', ')
    return {
        status,
        title: status === 'down' ? `${problems.value.length} layanan bermasalah` : 'Ada layanan yang perlu dicek',
        text: names,
    }
})

const checkedAgo = computed(() => (snapshot.value ? relative(snapshot.value.checked_at) : '—'))

function relative(iso) {
    if (!iso) return '—'
    const seconds = Math.max(0, Math.round((now.value - new Date(iso).getTime()) / 1000))
    if (seconds < 5) return 'baru saja'
    if (seconds < 60) return `${seconds} detik lalu`
    if (seconds < 3600) return `${Math.floor(seconds / 60)} menit lalu`
    return dayjs(iso).format('DD MMM HH:mm')
}

function bytes(value) {
    if (value == null) return '—'
    const unitsList = ['B', 'KB', 'MB', 'GB', 'TB']
    let power = 0
    let amount = value
    while (amount >= 1024 && power < unitsList.length - 1) {
        amount /= 1024
        power++
    }
    return `${amount.toFixed(power >= 3 ? 1 : 0)} ${unitsList[power]}`
}

function duration(seconds) {
    if (seconds == null) return '—'
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return days ? `${days} hari ${hours} jam` : `${hours} jam ${minutes} menit`
}

const memoryPercent = computed(() => {
    const memory = system.value?.memory
    return memory ? Math.round((memory.used / memory.total) * 100) : null
})
// Beban 1 menit dibanding jumlah CPU: >100% = antrean proses menumpuk.
const loadPercent = computed(() => {
    const load = system.value?.load?.[0]
    const cpus = system.value?.cpu_count
    return load != null && cpus ? Math.round((load / cpus) * 100) : null
})
const gaugeTone = (percent) =>
    percent == null ? 'bg-base-700' : percent >= 90 ? 'bg-danger-400' : percent >= 75 ? 'bg-st-idle' : 'bg-st-working'

async function check({ manual = false } = {}) {
    if (loading.value) return
    loading.value = true
    try {
        const response = await api.get('/system/status')
        snapshot.value = response.data.data
        failed.value = false
    } catch (err) {
        failed.value = !err.response || err.response.status >= 500
        if (manual || !failed.value) toast.error('Gagal memeriksa server', err.response?.data?.message)
    } finally {
        loading.value = false
        const status = failed.value ? 'down' : (snapshot.value?.overall ?? 'unknown')
        history.value = [...history.value, { status, at: new Date().toISOString() }].slice(-HISTORY_LENGTH)
    }
}

onMounted(() => {
    check()
    timer = setInterval(check, REFRESH_MS)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Akses"
            title="Status server"
            subtitle="Kondisi semua layanan yang menjalankan Lacak SMB, diperiksa langsung dari server tiap 15 detik selama halaman ini terbuka."
        >
            <template #actions>
                <BaseButton variant="outline" size="sm" :loading="loading" @click="check({ manual: true })">
                    <RefreshCw class="size-4" />
                    Periksa sekarang
                </BaseButton>
            </template>
            <template #readouts>
                <Readout
                    label="Kondisi"
                    :value="{ ok: 'Normal', warn: 'Perlu dicek', down: 'Gangguan', unknown: '—' }[overall.status]"
                    :led="{ ok: 'accent', warn: 'warning', down: 'danger', unknown: 'muted' }[overall.status]"
                />
                <Readout label="Layanan normal" :value="snapshot ? `${okCount}/${services.length}` : '—'" />
                <Readout label="Diperiksa" :value="checkedAgo" />
                <Readout v-if="system?.environment" label="Lingkungan" :value="system.environment" />
            </template>
        </PageHeader>

        <div class="grid gap-5 p-4 sm:p-8">
            <!-- Kesimpulan satu baris: yang pertama dilihat admin -->
            <section
                class="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border px-5 py-4 shadow-(--shadow-card)"
                :class="meta(overall.status).chip"
                role="status"
                aria-live="polite"
            >
                <span class="led size-3" :class="[meta(overall.status).led, overall.status === 'down' && 'motion-safe:animate-pulse']" />
                <div class="min-w-0 flex-1">
                    <p class="font-display text-lg font-bold tracking-[-0.015em]">{{ overall.title }}</p>
                    <p v-if="overall.text" class="mt-0.5 text-sm text-pretty opacity-90">{{ overall.text }}</p>
                </div>
                <!-- Riwayat pemeriksaan selama halaman terbuka -->
                <div class="flex flex-col items-end gap-1.5">
                    <div class="flex h-6 items-end gap-0.5" aria-label="Riwayat pemeriksaan">
                        <span
                            v-for="(entry, index) in history"
                            :key="index"
                            class="w-1.5 rounded-sm"
                            :class="[meta(entry.status).bar, entry.status === 'ok' ? 'h-6' : 'h-4']"
                            :title="`${dayjs(entry.at).format('HH:mm:ss')} · ${meta(entry.status).label}`"
                        />
                    </div>
                    <p class="text-[11px] opacity-75 font-semibold">Riwayat sesi ini</p>
                </div>
            </section>

            <!-- Layanan -->
            <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <article
                    v-for="service in services"
                    :key="service.key"
                    class="flex flex-col rounded-xl border bg-base-900 p-4 shadow-(--shadow-card)"
                    :class="
                        service.status === 'down'
                            ? 'border-danger-500/40'
                            : service.status === 'warn'
                              ? 'border-st-idle/40'
                              : 'border-base-800'
                    "
                >
                    <div class="flex items-start gap-3">
                        <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-base-850 text-base-300">
                            <component :is="ICONS[service.key] ?? Server" class="size-4.5" />
                        </span>
                        <div class="min-w-0 flex-1">
                            <h3 class="text-sm leading-snug font-semibold text-base-50">{{ service.name }}</h3>
                            <span
                                class="mt-1.5 inline-flex items-center gap-1.5 rounded-full border px-1.5 py-0.5 text-[11px] font-semibold"
                                :class="meta(service.status).chip"
                            >
                                <span class="led" :class="meta(service.status).led" />
                                {{ meta(service.status).label }}
                            </span>
                        </div>
                    </div>
                    <p class="mt-3 flex-1 text-sm text-pretty text-base-300">{{ service.detail }}</p>
                    <p v-if="service.status === 'down' || service.status === 'warn'" class="mt-2 text-xs text-pretty text-base-500">
                        Dampak: {{ IMPACT[service.key] }}
                    </p>
                    <dl class="mt-3 flex gap-4 border-t border-base-800 pt-2.5 font-mono text-[11px] text-base-500 tabular-nums">
                        <div v-if="service.latency_ms != null" class="flex gap-1.5">
                            <dt>Respons</dt>
                            <dd class="text-base-300">{{ service.latency_ms }} ms</dd>
                        </div>
                        <div v-if="service.last_seen_at" class="flex gap-1.5">
                            <dt>Detak terakhir</dt>
                            <dd class="text-base-300">{{ relative(service.last_seen_at) }}</dd>
                        </div>
                        <div v-if="service.latency_ms == null && !service.last_seen_at">—</div>
                    </dl>
                </article>
                <template v-if="!snapshot && !failed">
                    <div v-for="n in 8" :key="n" class="h-40 animate-pulse rounded-xl border border-base-800 bg-base-900" />
                </template>
            </div>

            <div class="grid gap-5 xl:grid-cols-2">
                <!-- Unit systemd -->
                <BaseCard title="Layanan sistem (systemd)" :count="units.length || null">
                    <ul v-if="units.length" class="divide-y divide-base-800">
                        <li v-for="unit in units" :key="unit.name" class="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                            <span class="led" :class="meta(unit.status).led" />
                            <span class="min-w-0 flex-1 truncate font-mono text-sm text-base-100">{{ unit.name }}</span>
                            <span
                                class="rounded-full border px-1.5 py-0.5 text-[11px] font-semibold"
                                :class="meta(unit.status).chip"
                            >
                                {{ unit.state }}
                            </span>
                        </li>
                    </ul>
                    <p v-else class="text-sm text-pretty text-base-500">
                        Status unit systemd hanya tampil saat backend berjalan di server Linux. Daftar unit diatur lewat
                        <code class="font-mono text-base-300">LACAKSMB_STATUS_SYSTEMD_UNITS</code>.
                    </p>
                    <p v-if="units.some((unit) => unit.status === 'down')" class="mt-4 text-xs text-pretty text-base-500">
                        Jalankan di server:
                        <code class="font-mono text-base-300"
                            >sudo systemctl restart
                            {{
                                units
                                    .filter((unit) => unit.status === 'down')
                                    .map((unit) => unit.name)
                                    .join(' ')
                            }}</code
                        >
                    </p>
                </BaseCard>

                <!-- Mesin server -->
                <BaseCard title="Mesin server">
                    <div v-if="system" class="grid gap-5">
                        <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                            <div>
                                <dt class="eyebrow">Host</dt>
                                <dd class="mt-1 truncate font-mono text-base-100">{{ system.hostname ?? '—' }}</dd>
                            </div>
                            <div>
                                <dt class="eyebrow">Sistem</dt>
                                <dd class="mt-1 font-mono text-base-100">{{ system.os }}</dd>
                            </div>
                            <div>
                                <dt class="eyebrow flex items-center gap-1.5"><Clock class="size-3" /> Menyala</dt>
                                <dd class="mt-1 font-mono text-base-100">{{ duration(system.uptime_seconds) }}</dd>
                            </div>
                            <div>
                                <dt class="eyebrow">Zona waktu</dt>
                                <dd class="mt-1 font-mono text-base-100">{{ system.timezone }}</dd>
                            </div>
                        </dl>

                        <div>
                            <div class="flex items-center justify-between text-sm">
                                <span class="eyebrow flex items-center gap-1.5"><Cpu class="size-3" /> Beban CPU</span>
                                <span class="font-mono text-base-200 tabular-nums">
                                    {{ system.load ? system.load.map((value) => value.toFixed(2)).join(' · ') : '—' }}
                                    <span v-if="system.cpu_count" class="text-base-500">/ {{ system.cpu_count }} inti</span>
                                </span>
                            </div>
                            <div class="mt-2 h-2 overflow-hidden rounded-full bg-base-850">
                                <div
                                    class="h-full rounded-full transition-[width]"
                                    :class="gaugeTone(loadPercent)"
                                    :style="{ width: `${Math.min(loadPercent ?? 0, 100)}%` }"
                                />
                            </div>
                        </div>

                        <div>
                            <div class="flex items-center justify-between text-sm">
                                <span class="eyebrow flex items-center gap-1.5"><MemoryStick class="size-3" /> Memori</span>
                                <span class="font-mono text-base-200 tabular-nums">
                                    <template v-if="system.memory">
                                        {{ bytes(system.memory.used) }} / {{ bytes(system.memory.total) }} ({{ memoryPercent }}%)
                                    </template>
                                    <template v-else>—</template>
                                </span>
                            </div>
                            <div class="mt-2 h-2 overflow-hidden rounded-full bg-base-850">
                                <div
                                    class="h-full rounded-full transition-[width]"
                                    :class="gaugeTone(memoryPercent)"
                                    :style="{ width: `${memoryPercent ?? 0}%` }"
                                />
                            </div>
                        </div>
                        <p v-if="!system.load && !system.memory" class="text-xs text-base-500">
                            Beban CPU & memori hanya terbaca di server Linux.
                        </p>
                    </div>
                    <p v-else class="text-sm text-base-500">Memuat…</p>
                </BaseCard>
            </div>
        </div>
    </div>
</template>
