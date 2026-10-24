<script setup>
import { ClipboardList } from '@lucide/vue'
import dayjs from 'dayjs'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import BaseCard from '@/components/ui/BaseCard.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { WORK_EVENT_LABELS, formatDuration, workStatus } from '@/lib/workStatus'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const toast = useToast()

const sites = ref([])
const siteId = ref(null)
const date = ref(dayjs().format('YYYY-MM-DD'))
const staffFilter = ref('')
const summary = ref([])
const events = ref([])
const loading = ref(false)
let refreshTimer = null

const isToday = computed(() => date.value === dayjs().format('YYYY-MM-DD'))

const filteredEvents = computed(() =>
    // Terbaru di atas: yang dicari biasanya kejadian barusan.
    [...events.value].filter((event) => !staffFilter.value || event.user_id === staffFilter.value).reverse(),
)

const totals = computed(() => ({
    work: summary.value.reduce((total, row) => total + row.work_seconds, 0),
    working: summary.value.filter((row) => row.status === 'working').length,
}))

async function loadSites() {
    const response = await api.get('/live/sites')
    sites.value = response.data.data
    siteId.value = sites.value.find((site) => site.id === auth.user?.organization_id)?.id ?? sites.value[0]?.id ?? null
}

async function loadLog({ quiet = false } = {}) {
    if (!siteId.value || !date.value) return
    if (!quiet) loading.value = true
    try {
        // Satu hari kalender menurut jam perangkat ini (WIB/WITA/WIT), bukan UTC server.
        const day = dayjs(date.value)
        const response = await api.get('/live/activity', {
            params: { organization_id: siteId.value, from: day.startOf('day').toISOString(), to: day.endOf('day').toISOString() },
        })
        summary.value = response.data.data.summary
        events.value = response.data.data.events
    } catch (err) {
        if (!quiet) toast.error('Gagal memuat log kerja', err.response?.data?.message)
    } finally {
        loading.value = false
    }
}

watch([siteId, date], () => {
    staffFilter.value = ''
    loadLog()
})

onMounted(async () => {
    try {
        await loadSites()
    } catch (err) {
        toast.error('Gagal memuat daftar site', err.response?.data?.message)
    }
    // Hari ini: jam kerja & status terus bergerak -- segarkan tiap 30 detik.
    refreshTimer = setInterval(() => isToday.value && loadLog({ quiet: true }), 30_000)
})

onBeforeUnmount(() => clearInterval(refreshTimer))
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Pantau"
            title="Log kerja"
            subtitle="Kapan staf login, mulai kerja, menyalakan layar & kamera, istirahat, dan selesai. Jam kerja aktual hanya menghitung waktu berstatus Working."
        >
            <template #readouts>
                <Readout label="Staf tercatat" :value="summary.length" />
                <Readout label="Sedang working" :value="totals.working" :led="totals.working ? 'accent' : 'muted'" />
                <Readout label="Total jam kerja" :value="formatDuration(totals.work)" />
            </template>
        </PageHeader>

        <div class="space-y-6 p-4 sm:p-8">
            <div class="grid gap-3 sm:grid-cols-[minmax(0,16rem)_12rem_minmax(0,16rem)]">
                <BaseSelect v-if="sites.length > 1" v-model="siteId" label="Site">
                    <option v-for="site in sites" :key="site.id" :value="site.id">{{ site.name }}</option>
                </BaseSelect>
                <BaseInput v-model="date" label="Tanggal" type="date" :max="dayjs().format('YYYY-MM-DD')" />
                <BaseSelect v-model="staffFilter" label="Staf">
                    <option value="">Semua staf</option>
                    <option v-for="row in summary" :key="row.user_id" :value="row.user_id">{{ row.user_name }}</option>
                </BaseSelect>
            </div>

            <BaseCard
                title="Jam kerja aktual"
                :count="loading ? null : summary.length"
                subtitle="Istirahat, terputus, idle, dan kamera/layar mati tidak dihitung."
                flush
            >
                <div v-if="loading" class="px-5 py-12 text-center text-sm text-base-500">Memuat log…</div>
                <EmptyState
                    v-else-if="!summary.length"
                    :icon="ClipboardList"
                    title="Belum ada aktivitas"
                    description="Log muncul begitu staf login atau menekan Mulai kerja di Live Kerja."
                />
                <div v-else class="overflow-x-auto">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Staf</th>
                                <th>Status</th>
                                <th class="hidden sm:table-cell">Login pertama</th>
                                <th>Jam kerja</th>
                                <th class="hidden sm:table-cell">Istirahat</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="row in summary" :key="row.user_id">
                                <td class="font-medium text-base-50">{{ row.user_name }}</td>
                                <td>
                                    <span
                                        class="inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[10.5px] tracking-[0.1em] uppercase"
                                        :class="workStatus(row.status).chip"
                                    >
                                        {{ workStatus(row.status).emoji }} {{ workStatus(row.status).label }}
                                    </span>
                                </td>
                                <td class="hidden font-mono text-base-300 tabular-nums sm:table-cell">
                                    {{ row.first_login_at ? dayjs(row.first_login_at).format('HH:mm:ss') : '—' }}
                                </td>
                                <td class="font-mono text-base-50 tabular-nums">{{ formatDuration(row.work_seconds) }}</td>
                                <td class="hidden font-mono text-base-300 tabular-nums sm:table-cell">
                                    {{ formatDuration(row.break_seconds) }}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </BaseCard>

            <BaseCard title="Aktivitas" :count="loading ? null : filteredEvents.length" flush>
                <div v-if="loading" class="px-5 py-12 text-center text-sm text-base-500">Memuat log…</div>
                <p v-else-if="!filteredEvents.length" class="px-5 py-10 text-center text-sm text-base-500">
                    Tidak ada aktivitas di tanggal ini.
                </p>
                <div v-else class="max-h-[36rem] overflow-auto">
                    <table class="data-table">
                        <thead class="sticky top-0 bg-base-900">
                            <tr>
                                <th>Waktu</th>
                                <th>Staf</th>
                                <th>Aktivitas</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="event in filteredEvents" :key="event.id">
                                <td class="font-mono text-base-300 tabular-nums">{{ dayjs(event.occurred_at).format('HH:mm:ss') }}</td>
                                <td class="text-base-100">{{ event.user_name }}</td>
                                <td class="text-base-100">{{ WORK_EVENT_LABELS[event.type] ?? event.type }}</td>
                                <td>
                                    <span
                                        class="inline-flex items-center gap-1.5 font-mono text-[10.5px] tracking-[0.1em] text-base-300 uppercase"
                                    >
                                        {{ workStatus(event.status).emoji }} {{ workStatus(event.status).label }}
                                    </span>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </BaseCard>
        </div>
    </div>
</template>
