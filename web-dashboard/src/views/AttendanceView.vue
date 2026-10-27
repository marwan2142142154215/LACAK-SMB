<script setup>
import { BellRing, CalendarClock, Clock3, Download, Pencil, Plus, Send, Trash2, Users } from '@lucide/vue'
import dayjs from 'dayjs'
import { computed, onMounted, ref, watch } from 'vue'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { ATTENDANCE_STATUS, WEEKDAYS, clock, describeDays, minutesLabel, statusLabel } from '@/lib/attendance'
import { formatDuration } from '@/lib/workStatus'
import { buildXlsx, downloadBlob } from '@/lib/xlsx'

const toast = useToast()

const TABS = [
    { value: 'recap', label: 'Rekap absensi', icon: CalendarClock },
    { value: 'shifts', label: 'Shift', icon: Clock3 },
    { value: 'alerts', label: 'Peringatan & laporan', icon: BellRing },
]
const tab = ref('recap')

const sites = ref([])
const siteId = ref(null)
const canManage = ref(false)

// ===== Rekap =====
const RANGES = [
    { value: 'today', label: 'Hari ini' },
    { value: 'week', label: '7 hari' },
    { value: 'month', label: 'Bulan ini' },
    { value: 'last_month', label: 'Bulan lalu' },
    { value: 'custom', label: 'Pilih tanggal' },
]
const range = ref('today')
const from = ref(dayjs().format('YYYY-MM-DD'))
const to = ref(dayjs().format('YYYY-MM-DD'))
const days = ref([])
const loadingRecap = ref(false)
const search = ref('')
const detailUser = ref(null)

function applyRange(value) {
    const today = dayjs()
    const ranges = {
        today: [today, today],
        week: [today.subtract(6, 'day'), today],
        month: [today.startOf('month'), today],
        last_month: [today.subtract(1, 'month').startOf('month'), today.subtract(1, 'month').endOf('month')],
    }
    if (ranges[value]) {
        from.value = ranges[value][0].format('YYYY-MM-DD')
        to.value = ranges[value][1].format('YYYY-MM-DD')
    }
}

async function loadRecap() {
    if (to.value < from.value) return toast.error('Rentang tanggal terbalik', 'Tanggal akhir harus setelah tanggal awal.')
    loadingRecap.value = true
    try {
        const { data } = await api.get('/attendance', {
            params: { from: from.value, to: to.value, ...(siteId.value ? { organization_id: siteId.value } : {}) },
        })
        canManage.value = data.data.can_manage
        if (!sites.value.length) sites.value = data.data.sites
        if (!siteId.value && data.data.organization_id) siteId.value = data.data.organization_id
        days.value = data.data.items
    } catch (err) {
        toast.error('Gagal memuat absensi', err.response?.data?.message)
    } finally {
        loadingRecap.value = false
    }
}

const singleDay = computed(() => from.value === to.value)
const matches = (name) => !search.value.trim() || name?.toLowerCase().includes(search.value.trim().toLowerCase())

const perUser = computed(() => {
    const map = new Map()
    for (const day of days.value) {
        if (!matches(day.user_name)) continue
        const row = map.get(day.user_id) ?? {
            user_id: day.user_id,
            name: day.user_name,
            shift: day.shift,
            days: [],
            present: 0,
            late: 0,
            lateMinutes: 0,
            absent: 0,
            leave: 0,
            work: 0,
            overtime: 0,
            faceLost: 0,
        }
        row.days.push(day)
        if (day.status === 'present' || day.status === 'late') row.present++
        if (day.status === 'late') {
            row.late++
            row.lateMinutes += day.late_minutes
        }
        if (day.status === 'absent') row.absent++
        if (day.status === 'leave') row.leave++
        row.work += day.work_seconds
        row.overtime += day.overtime_minutes
        row.faceLost += day.face_lost_count
        map.set(day.user_id, row)
    }
    return [...map.values()]
})

const totals = computed(() => {
    const rows = perUser.value
    return {
        present: rows.reduce((sum, row) => sum + row.present, 0),
        late: rows.reduce((sum, row) => sum + row.late, 0),
        absent: rows.reduce((sum, row) => sum + row.absent + row.days.filter((day) => day.status === 'not_started').length, 0),
        leave: rows.reduce((sum, row) => sum + row.leave, 0),
        work: rows.reduce((sum, row) => sum + row.work, 0),
    }
})

const detailRow = computed(() => perUser.value.find((row) => row.user_id === detailUser.value) ?? null)
const siteName = computed(() => sites.value.find((site) => site.id === siteId.value)?.name ?? 'Saya')

function exportExcel() {
    const header = [
        'Tanggal',
        'Nama',
        'Shift',
        'Jam shift',
        'Status',
        'Masuk',
        'Pulang',
        'Jam kerja (jam)',
        'Terlambat (menit)',
        'Pulang cepat (menit)',
        'Lembur (menit)',
        'Istirahat (jam)',
        'Wajah hilang ≥5 mnt',
    ]
    const detail = days.value.map((day) => [
        day.date,
        day.user_name,
        day.shift?.name ?? '',
        day.shift ? `${day.shift.start_time}–${day.shift.end_time}` : '',
        statusLabel(day),
        day.first_start_at ? dayjs(day.first_start_at).format('YYYY-MM-DD HH:mm') : '',
        day.last_end_at ? dayjs(day.last_end_at).format('YYYY-MM-DD HH:mm') : '',
        Math.round((day.work_seconds / 3600) * 100) / 100,
        day.late_minutes,
        day.early_leave_minutes,
        day.overtime_minutes,
        Math.round((day.break_seconds / 3600) * 100) / 100,
        day.face_lost_count,
    ])
    const summaryHeader = [
        'Nama',
        'Shift',
        'Hari hadir',
        'Terlambat (kali)',
        'Total terlambat (menit)',
        'Tidak masuk (hari)',
        'Izin/sakit/cuti (hari)',
        'Jam kerja (jam)',
        'Lembur (jam)',
        'Wajah hilang ≥5 mnt',
    ]
    const summary = perUser.value.map((row) => [
        row.name,
        row.shift?.name ?? '',
        row.present,
        row.late,
        row.lateMinutes,
        row.absent,
        row.leave,
        Math.round((row.work / 3600) * 100) / 100,
        Math.round((row.overtime / 60) * 100) / 100,
        row.faceLost,
    ])
    const blob = buildXlsx([
        { name: 'Ringkasan', rows: [summaryHeader, ...summary], widths: [28, 16, 11, 15, 22, 18, 21, 15, 12, 19] },
        { name: 'Per hari', rows: [header, ...detail], widths: [12, 28, 16, 13, 14, 17, 17, 15, 17, 19, 14, 15, 19] },
    ])
    downloadBlob(blob, `absensi-${siteName.value.replace(/\s+/g, '-').toLowerCase()}-${from.value}_${to.value}.xlsx`)
}

// ===== Shift =====
const shifts = ref([])
const shiftStaff = ref([])
const loadingShifts = ref(false)
const shiftDialog = ref(false)
const savingShift = ref(false)
const shiftForm = ref(null)
const deleteShift = ref(null)
const deletingShift = ref(false)
const selectedStaff = ref([])
const assignTo = ref(null)
const assigning = ref(false)

async function loadShifts() {
    if (!siteId.value) return
    loadingShifts.value = true
    try {
        const { data } = await api.get('/work-shifts', { params: { organization_id: siteId.value } })
        shifts.value = data.data.shifts
        shiftStaff.value = data.data.staff
        selectedStaff.value = []
    } catch (err) {
        toast.error('Gagal memuat shift', err.response?.data?.message)
    } finally {
        loadingShifts.value = false
    }
}

function openShift(shift = null) {
    shiftForm.value = shift
        ? { ...shift, days: [...shift.days] }
        : { id: null, name: '', start_time: '08:00', end_time: '17:00', days: [1, 2, 3, 4, 5], late_tolerance_minutes: 10 }
    shiftDialog.value = true
}

function toggleDay(value) {
    const list = shiftForm.value.days
    const index = list.indexOf(value)
    if (index >= 0) list.splice(index, 1)
    else list.push(value)
}

async function saveShift() {
    const form = shiftForm.value
    if (!form.days.length) return toast.error('Pilih hari kerja', 'Minimal satu hari.')
    savingShift.value = true
    try {
        const payload = {
            organization_id: siteId.value,
            name: form.name,
            start_time: form.start_time,
            end_time: form.end_time,
            days: form.days,
            late_tolerance_minutes: Number(form.late_tolerance_minutes) || 0,
        }
        if (form.id) await api.put(`/work-shifts/${form.id}`, payload)
        else await api.post('/work-shifts', payload)
        toast.success(form.id ? 'Shift diperbarui' : 'Shift dibuat', `${form.name} ${form.start_time}–${form.end_time}`)
        shiftDialog.value = false
        loadShifts()
    } catch (err) {
        toast.error('Shift belum tersimpan', err.response?.data?.message)
    } finally {
        savingShift.value = false
    }
}

async function confirmDeleteShift() {
    deletingShift.value = true
    try {
        await api.delete(`/work-shifts/${deleteShift.value.id}`)
        toast.success('Shift dihapus', 'Staf di shift itu kini tanpa shift.')
        loadShifts()
    } catch (err) {
        toast.error('Shift belum terhapus', err.response?.data?.message)
    } finally {
        deletingShift.value = false
        deleteShift.value = null
    }
}

const shiftName = (id) => shifts.value.find((shift) => shift.id === id)?.name
const filteredStaff = computed(() => shiftStaff.value.filter((member) => matches(member.name)))
const allSelected = computed(
    () => filteredStaff.value.length > 0 && filteredStaff.value.every((member) => selectedStaff.value.includes(member.id)),
)

function toggleStaff(id) {
    const index = selectedStaff.value.indexOf(id)
    if (index >= 0) selectedStaff.value.splice(index, 1)
    else selectedStaff.value.push(id)
}

function toggleAll() {
    selectedStaff.value = allSelected.value ? [] : filteredStaff.value.map((member) => member.id)
}

async function assignShift() {
    assigning.value = true
    try {
        await api.put('/work-shifts/assignments', { user_ids: selectedStaff.value, work_shift_id: assignTo.value })
        toast.success(
            assignTo.value ? 'Shift dipasang' : 'Shift dilepas',
            `${selectedStaff.value.length} staf ${assignTo.value ? `kini di shift ${shiftName(assignTo.value)}` : 'tanpa shift'}.`,
        )
        loadShifts()
    } catch (err) {
        toast.error('Shift belum dipasang', err.response?.data?.message)
    } finally {
        assigning.value = false
    }
}

// ===== Peringatan =====
const settings = ref(null)
const savingSettings = ref(false)
const alerts = ref([])
const alertTypes = ref([])
const alertType = ref(null)
const loadingAlerts = ref(false)

async function loadAlerts() {
    if (!siteId.value) return
    loadingAlerts.value = true
    try {
        const [settingsResponse, alertsResponse] = await Promise.all([
            api.get(`/work-alert-settings/${siteId.value}`),
            api.get('/work-alerts', { params: { organization_id: siteId.value, ...(alertType.value ? { type: alertType.value } : {}) } }),
        ])
        settings.value = settingsResponse.data.data
        alerts.value = alertsResponse.data.data.items
        alertTypes.value = alertsResponse.data.data.types
    } catch (err) {
        toast.error('Gagal memuat peringatan', err.response?.data?.message)
    } finally {
        loadingAlerts.value = false
    }
}

async function saveSettings() {
    savingSettings.value = true
    try {
        const form = settings.value
        await api.put(`/work-alert-settings/${siteId.value}`, {
            alerts_enabled: form.alerts_enabled,
            camera_off_minutes: Number(form.camera_off_minutes),
            face_missing_minutes: Number(form.face_missing_minutes),
            absent_alert: form.absent_alert,
            daily_report: form.daily_report,
            weekly_report: form.weekly_report,
            report_time: form.report_time,
        })
        toast.success('Pengaturan disimpan', 'Berlaku mulai menit berikutnya.')
    } catch (err) {
        toast.error('Pengaturan belum tersimpan', err.response?.data?.message)
    } finally {
        savingSettings.value = false
    }
}

const telegramNote = computed(() => {
    if (!settings.value) return null
    if (!settings.value.telegram_enabled) return 'Token bot Telegram belum dipasang di server, jadi pesan hanya tercatat di sini.'
    if (!settings.value.telegram_bound) return 'Site ini belum punya chat Telegram. Ikat chat di menu Bot Telegram agar pesan terkirim.'
    return 'Pesan dikirim ke chat Telegram site ini dan dicatat di bawah.'
})

// ===== Muat =====
function loadTab() {
    if (tab.value === 'recap') loadRecap()
    else if (tab.value === 'shifts') loadShifts()
    else loadAlerts()
}

watch(range, (value) => {
    applyRange(value)
    if (value !== 'custom') loadRecap()
})
watch(siteId, (value, old) => old && loadTab())
watch(tab, loadTab)
watch(alertType, loadAlerts)

onMounted(async () => {
    applyRange(range.value)
    await loadRecap()
})
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Kerja"
            title="Absensi"
            :subtitle="
                canManage
                    ? 'Kehadiran dari Live Kerja dibandingkan dengan shift staf: terlambat, pulang cepat, lembur, tidak masuk, dan izin.'
                    : 'Kehadiran Anda dari Live Kerja, dibandingkan dengan shift Anda.'
            "
        >
            <template #actions>
                <BaseSelect v-if="sites.length > 1" v-model="siteId" class="w-56" aria-label="Site">
                    <option v-for="site in sites" :key="site.id" :value="site.id">{{ site.name }}</option>
                </BaseSelect>
            </template>
        </PageHeader>

        <div class="px-4 sm:px-8">
            <div v-if="canManage" class="mt-4 flex gap-1 overflow-x-auto rounded-xl bg-base-900 p-1 shadow-(--shadow-card)" role="tablist">
                <button
                    v-for="item in TABS"
                    :key="item.value"
                    type="button"
                    role="tab"
                    :aria-selected="tab === item.value"
                    class="inline-flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors"
                    :class="tab === item.value ? 'bg-base-850 text-base-50' : 'text-base-400 hover:text-base-200'"
                    @click="tab = item.value"
                >
                    <component :is="item.icon" class="size-4" :class="tab === item.value && 'text-accent-500'" />
                    {{ item.label }}
                </button>
            </div>
        </div>

        <!-- ===== Rekap ===== -->
        <div v-if="tab === 'recap'" class="space-y-5 p-4 sm:p-8">
            <div class="flex flex-wrap items-end gap-3">
                <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Rentang">
                    <button
                        v-for="option in RANGES"
                        :key="option.value"
                        type="button"
                        role="radio"
                        :aria-checked="range === option.value"
                        class="rounded-full border px-3 py-1.5 text-sm font-medium transition-colors"
                        :class="
                            range === option.value
                                ? 'border-transparent bg-base-50 text-base-950'
                                : 'border-base-700 text-base-300 hover:border-base-600'
                        "
                        @click="range = option.value"
                    >
                        {{ option.label }}
                    </button>
                </div>
                <template v-if="range === 'custom'">
                    <BaseInput v-model="from" type="date" label="Dari" class="w-40" />
                    <BaseInput v-model="to" type="date" label="Sampai" class="w-40" />
                    <BaseButton variant="outline" :loading="loadingRecap" @click="loadRecap">Tampilkan</BaseButton>
                </template>
                <div class="ml-auto flex gap-2">
                    <input
                        v-if="canManage"
                        v-model="search"
                        type="search"
                        placeholder="Cari staf"
                        class="field-control w-48"
                        aria-label="Cari staf"
                    />
                    <BaseButton variant="outline" :disabled="!days.length" @click="exportExcel">
                        <Download class="size-4" />
                        Unduh Excel
                    </BaseButton>
                </div>
            </div>

            <div class="flex flex-wrap gap-x-10 gap-y-4 rounded-2xl border border-base-800 bg-base-900 px-5 py-4 shadow-(--shadow-card)">
                <Readout :label="singleDay ? 'Hadir' : 'Hari hadir'" :value="totals.present" led="accent" />
                <Readout label="Terlambat" :value="totals.late" :led="totals.late ? 'warning' : 'muted'" />
                <Readout label="Tidak masuk" :value="totals.absent" :led="totals.absent ? 'danger' : 'muted'" />
                <Readout label="Izin / cuti" :value="totals.leave" led="copper" />
                <Readout label="Jam kerja" :value="formatDuration(totals.work)" />
            </div>

            <BaseCard
                :title="
                    singleDay
                        ? dayjs(from).format('dddd, D MMMM YYYY')
                        : `${dayjs(from).format('D MMM')} – ${dayjs(to).format('D MMM YYYY')}`
                "
                :count="perUser.length"
                flush
            >
                <div v-if="loadingRecap && !days.length" class="px-5 py-12 text-center text-sm text-base-500">Memuat absensi…</div>
                <EmptyState
                    v-else-if="!perUser.length"
                    :icon="CalendarClock"
                    title="Belum ada staf di site ini"
                    description="Staf aktif di site yang dipilih muncul di sini beserta kehadirannya."
                />
                <div v-else-if="singleDay" class="overflow-x-auto">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Staf</th>
                                <th class="hidden md:table-cell">Shift</th>
                                <th>Masuk</th>
                                <th class="hidden sm:table-cell">Pulang</th>
                                <th class="hidden sm:table-cell">Jam kerja</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="row in perUser" :key="row.user_id" class="cursor-pointer" @click="detailUser = row.user_id">
                                <td class="font-medium text-base-50">{{ row.name }}</td>
                                <td class="hidden text-base-400 md:table-cell">
                                    {{ row.shift ? `${row.shift.name} · ${row.shift.start_time}–${row.shift.end_time}` : '—' }}
                                </td>
                                <td class="font-mono tabular-nums">{{ clock(row.days[0].first_start_at) }}</td>
                                <td class="hidden font-mono tabular-nums sm:table-cell">{{ clock(row.days[0].last_end_at) }}</td>
                                <td class="hidden font-mono tabular-nums sm:table-cell">{{ formatDuration(row.days[0].work_seconds) }}</td>
                                <td>
                                    <div class="flex flex-wrap items-center gap-1.5">
                                        <BaseBadge :variant="ATTENDANCE_STATUS[row.days[0].status]?.variant">{{
                                            statusLabel(row.days[0])
                                        }}</BaseBadge>
                                        <span v-if="row.days[0].late_minutes" class="text-xs text-warning-400"
                                            >+{{ minutesLabel(row.days[0].late_minutes) }}</span
                                        >
                                        <span v-if="row.days[0].early_leave_minutes" class="text-xs text-base-400">
                                            pulang cepat {{ minutesLabel(row.days[0].early_leave_minutes) }}
                                        </span>
                                        <span v-if="row.days[0].overtime_minutes" class="text-xs text-st-working"
                                            >lembur {{ minutesLabel(row.days[0].overtime_minutes) }}</span
                                        >
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div v-else class="overflow-x-auto">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Staf</th>
                                <th>Hadir</th>
                                <th>Terlambat</th>
                                <th>Tidak masuk</th>
                                <th class="hidden sm:table-cell">Izin</th>
                                <th class="hidden md:table-cell">Jam kerja</th>
                                <th class="hidden md:table-cell">Lembur</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="row in perUser" :key="row.user_id" class="cursor-pointer" @click="detailUser = row.user_id">
                                <td>
                                    <p class="font-medium text-base-50">{{ row.name }}</p>
                                    <p class="text-xs text-base-500">{{ row.shift?.name ?? 'Tanpa shift' }}</p>
                                </td>
                                <td class="font-mono tabular-nums">{{ row.present }} hr</td>
                                <td class="font-mono tabular-nums" :class="row.late && 'text-warning-400'">
                                    {{ row.late }}×
                                    <span v-if="row.lateMinutes" class="text-xs text-base-500">({{ minutesLabel(row.lateMinutes) }})</span>
                                </td>
                                <td class="font-mono tabular-nums" :class="row.absent && 'text-danger-400'">{{ row.absent }} hr</td>
                                <td class="hidden font-mono tabular-nums sm:table-cell">{{ row.leave }} hr</td>
                                <td class="hidden font-mono tabular-nums md:table-cell">{{ formatDuration(row.work) }}</td>
                                <td class="hidden font-mono tabular-nums md:table-cell">{{ minutesLabel(row.overtime) }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </BaseCard>
            <p class="text-xs text-base-500">
                Terlambat dihitung dari jam mulai shift setelah lewat toleransinya. Lembur dicatat bila kerja melewati akhir shift minimal
                30 menit.
            </p>
        </div>

        <!-- ===== Shift ===== -->
        <div v-else-if="tab === 'shifts'" class="space-y-5 p-4 sm:p-8">
            <BaseCard
                title="Shift site ini"
                :count="shifts.length"
                subtitle="Jam kerja yang dipakai untuk menghitung terlambat dan tidak masuk."
            >
                <template #actions>
                    <BaseButton size="sm" @click="openShift()">
                        <Plus class="size-4" />
                        Tambah shift
                    </BaseButton>
                </template>
                <p v-if="!shifts.length" class="text-sm text-base-500">
                    Belum ada shift. Buat shift seperti "Pagi 08:00–17:00", lalu pasang ke staf di bawah.
                </p>
                <ul v-else class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    <li v-for="shift in shifts" :key="shift.id" class="rounded-xl border border-base-800 bg-base-850/50 p-4">
                        <div class="flex items-start justify-between gap-2">
                            <div class="min-w-0">
                                <p class="truncate font-display text-base font-bold text-base-50">{{ shift.name }}</p>
                                <p class="mt-0.5 font-mono text-lg text-base-100 tabular-nums">
                                    {{ shift.start_time }}–{{ shift.end_time }}
                                </p>
                            </div>
                            <div class="flex shrink-0 gap-1">
                                <BaseButton size="icon" variant="ghost" :aria-label="`Ubah ${shift.name}`" @click="openShift(shift)"
                                    ><Pencil class="size-4"
                                /></BaseButton>
                                <BaseButton size="icon" variant="ghost" :aria-label="`Hapus ${shift.name}`" @click="deleteShift = shift"
                                    ><Trash2 class="size-4"
                                /></BaseButton>
                            </div>
                        </div>
                        <p class="mt-2 text-sm text-base-400">
                            {{ describeDays(shift.days) }} · toleransi {{ shift.late_tolerance_minutes }} menit
                        </p>
                        <p class="mt-1 flex items-center gap-1.5 text-xs text-base-500">
                            <Users class="size-3.5" /> {{ shift.staff_count }} staf
                        </p>
                    </li>
                </ul>
            </BaseCard>

            <BaseCard title="Pasang shift ke staf" :count="shiftStaff.length" flush>
                <template #actions>
                    <input v-model="search" type="search" placeholder="Cari staf" class="field-control w-44" aria-label="Cari staf" />
                </template>
                <div class="flex flex-wrap items-center gap-2 border-b border-base-800 bg-base-850/40 px-5 py-3">
                    <span class="text-sm text-base-300">{{ selectedStaff.length }} dipilih</span>
                    <BaseSelect v-model="assignTo" class="w-52" aria-label="Shift tujuan">
                        <option :value="null">Tanpa shift</option>
                        <option v-for="shift in shifts" :key="shift.id" :value="shift.id">
                            {{ shift.name }} ({{ shift.start_time }}–{{ shift.end_time }})
                        </option>
                    </BaseSelect>
                    <BaseButton size="sm" :disabled="!selectedStaff.length" :loading="assigning" @click="assignShift">Terapkan</BaseButton>
                </div>
                <div v-if="loadingShifts" class="px-5 py-10 text-center text-sm text-base-500">Memuat staf…</div>
                <div v-else class="max-h-[32rem] overflow-y-auto">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th class="w-0">
                                    <input
                                        type="checkbox"
                                        class="size-4 accent-accent-500"
                                        :checked="allSelected"
                                        aria-label="Pilih semua"
                                        @change="toggleAll"
                                    />
                                </th>
                                <th>Staf</th>
                                <th>Shift sekarang</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="member in filteredStaff" :key="member.id" class="cursor-pointer" @click="toggleStaff(member.id)">
                                <td>
                                    <input
                                        type="checkbox"
                                        class="size-4 accent-accent-500"
                                        :checked="selectedStaff.includes(member.id)"
                                        :aria-label="`Pilih ${member.name}`"
                                        @click.stop
                                        @change="toggleStaff(member.id)"
                                    />
                                </td>
                                <td class="font-medium text-base-50">{{ member.name }}</td>
                                <td class="text-base-400">{{ shiftName(member.work_shift_id) ?? '—' }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </BaseCard>
        </div>

        <!-- ===== Peringatan & laporan ===== -->
        <div v-else class="grid gap-5 p-4 sm:p-8 xl:grid-cols-[24rem_minmax(0,1fr)]">
            <BaseCard title="Pengaturan site ini" subtitle="Dicek setiap menit oleh server.">
                <form v-if="settings" class="space-y-4" @submit.prevent="saveSettings">
                    <p class="flex gap-2 rounded-xl bg-base-850 px-3 py-2.5 text-xs text-pretty text-base-300">
                        <Send class="mt-0.5 size-3.5 shrink-0 text-accent-500" />
                        {{ telegramNote }}
                    </p>
                    <label class="flex items-center justify-between gap-3">
                        <span class="text-sm font-medium text-base-100">Peringatan langsung</span>
                        <input v-model="settings.alerts_enabled" type="checkbox" class="size-4 accent-accent-500" />
                    </label>
                    <div class="grid grid-cols-2 gap-3" :class="!settings.alerts_enabled && 'opacity-50'">
                        <BaseInput
                            v-model="settings.camera_off_minutes"
                            type="number"
                            min="1"
                            max="240"
                            label="Kamera/layar mati (menit)"
                            :disabled="!settings.alerts_enabled"
                        />
                        <BaseInput
                            v-model="settings.face_missing_minutes"
                            type="number"
                            min="5"
                            max="240"
                            label="Wajah hilang (menit)"
                            :disabled="!settings.alerts_enabled"
                        />
                    </div>
                    <label class="flex items-center justify-between gap-3" :class="!settings.alerts_enabled && 'opacity-50'">
                        <span class="text-sm text-base-200">Staf belum Mulai kerja saat shift dimulai</span>
                        <input
                            v-model="settings.absent_alert"
                            type="checkbox"
                            class="size-4 accent-accent-500"
                            :disabled="!settings.alerts_enabled"
                        />
                    </label>
                    <hr class="border-base-800" />
                    <label class="flex items-center justify-between gap-3">
                        <span class="text-sm font-medium text-base-100">Laporan harian</span>
                        <input v-model="settings.daily_report" type="checkbox" class="size-4 accent-accent-500" />
                    </label>
                    <label class="flex items-center justify-between gap-3">
                        <span class="text-sm font-medium text-base-100"
                            >Laporan mingguan <span class="font-normal text-base-500">(Senin)</span></span
                        >
                        <input v-model="settings.weekly_report" type="checkbox" class="size-4 accent-accent-500" />
                    </label>
                    <BaseInput v-model="settings.report_time" type="time" label="Jam kirim laporan" />
                    <BaseButton type="submit" class="w-full" :loading="savingSettings">Simpan pengaturan</BaseButton>
                </form>
                <p v-else class="text-sm text-base-500">Memuat…</p>
            </BaseCard>

            <BaseCard title="Pesan terbaru" :count="alerts.length" flush>
                <template #actions>
                    <BaseSelect v-model="alertType" class="w-48" aria-label="Jenis pesan">
                        <option :value="null">Semua jenis</option>
                        <option v-for="type in alertTypes" :key="type.value" :value="type.value">{{ type.label }}</option>
                    </BaseSelect>
                </template>
                <EmptyState
                    v-if="!alerts.length && !loadingAlerts"
                    :icon="BellRing"
                    title="Belum ada peringatan"
                    description="Kamera mati terlalu lama, wajah tidak terlihat, staf belum mulai kerja, dan laporan harian muncul di sini."
                />
                <ul v-else class="divide-y divide-base-800">
                    <li v-for="alert in alerts" :key="alert.id" class="px-5 py-3.5">
                        <div class="flex flex-wrap items-center gap-2">
                            <BaseBadge
                                :variant="
                                    alert.type.includes('report')
                                        ? 'accent'
                                        : alert.type === 'briefing_reminder' || alert.type === 'announcement'
                                          ? 'neutral'
                                          : 'warning'
                                "
                            >
                                {{ alert.type_label }}
                            </BaseBadge>
                            <span class="text-xs text-base-500">{{ dayjs(alert.created_at).format('D MMM HH:mm') }}</span>
                            <span v-if="alert.sent_telegram" class="flex items-center gap-1 text-xs text-st-working"
                                ><Send class="size-3" /> Terkirim</span
                            >
                        </div>
                        <p class="mt-1.5 text-sm whitespace-pre-line text-base-200">{{ alert.message }}</p>
                    </li>
                </ul>
            </BaseCard>
        </div>

        <!-- Detail per staf -->
        <BaseDialog
            :open="!!detailRow"
            :title="detailRow?.name ?? ''"
            :description="
                detailRow?.shift
                    ? `Shift ${detailRow.shift.name} · ${detailRow.shift.start_time}–${detailRow.shift.end_time}`
                    : 'Tanpa shift'
            "
            size="lg"
            @update:open="(v) => !v && (detailUser = null)"
        >
            <ul v-if="detailRow" class="divide-y divide-base-800">
                <li v-for="day in [...detailRow.days].reverse()" :key="day.date" class="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                    <span class="w-28 text-sm text-base-300">{{ dayjs(day.date).format('ddd, D MMM') }}</span>
                    <BaseBadge :variant="ATTENDANCE_STATUS[day.status]?.variant">{{ statusLabel(day) }}</BaseBadge>
                    <span class="font-mono text-sm text-base-200 tabular-nums"
                        >{{ clock(day.first_start_at) }}–{{ clock(day.last_end_at) }}</span
                    >
                    <span class="font-mono text-sm text-base-400 tabular-nums">{{ formatDuration(day.work_seconds) }}</span>
                    <span v-if="day.late_minutes" class="text-xs text-warning-400">terlambat {{ minutesLabel(day.late_minutes) }}</span>
                    <span v-if="day.early_leave_minutes" class="text-xs text-base-400"
                        >pulang cepat {{ minutesLabel(day.early_leave_minutes) }}</span
                    >
                    <span v-if="day.overtime_minutes" class="text-xs text-st-working">lembur {{ minutesLabel(day.overtime_minutes) }}</span>
                </li>
            </ul>
        </BaseDialog>

        <!-- Tambah / ubah shift -->
        <BaseDialog
            :open="shiftDialog"
            :title="shiftForm?.id ? 'Ubah shift' : 'Tambah shift'"
            description="Shift malam boleh melewati tengah malam, mis. 22:00–06:00."
            @update:open="(v) => (shiftDialog = v)"
        >
            <form v-if="shiftForm" id="shift-form" class="space-y-4" @submit.prevent="saveShift">
                <BaseInput v-model="shiftForm.name" label="Nama shift" placeholder="Contoh: Pagi" required maxlength="80" />
                <div class="grid grid-cols-2 gap-3">
                    <BaseInput v-model="shiftForm.start_time" type="time" label="Mulai" required />
                    <BaseInput v-model="shiftForm.end_time" type="time" label="Selesai" required />
                </div>
                <fieldset>
                    <legend class="field-label">Hari kerja</legend>
                    <div class="flex flex-wrap gap-1.5">
                        <button
                            v-for="day in WEEKDAYS"
                            :key="day.value"
                            type="button"
                            :aria-pressed="shiftForm.days.includes(day.value)"
                            class="w-12 rounded-lg border py-1.5 text-sm font-semibold transition-colors"
                            :class="
                                shiftForm.days.includes(day.value)
                                    ? 'border-transparent bg-base-50 text-base-950'
                                    : 'border-base-700 text-base-400 hover:border-base-600'
                            "
                            @click="toggleDay(day.value)"
                        >
                            {{ day.short }}
                        </button>
                    </div>
                </fieldset>
                <BaseInput
                    v-model="shiftForm.late_tolerance_minutes"
                    type="number"
                    min="0"
                    max="240"
                    label="Toleransi terlambat (menit)"
                    hint="Mulai kerja setelah jam mulai + toleransi = terlambat."
                />
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="shiftDialog = false">Batal</BaseButton>
                <BaseButton type="submit" form="shift-form" :loading="savingShift">Simpan shift</BaseButton>
            </template>
        </BaseDialog>

        <ConfirmDialog
            :open="!!deleteShift"
            :title="`Hapus shift ${deleteShift?.name ?? ''}?`"
            description="Staf di shift ini menjadi tanpa shift. Rekap hari sebelumnya ikut tidak lagi memakai shift ini."
            confirm-label="Hapus shift"
            :loading="deletingShift"
            @confirm="confirmDeleteShift"
            @update:open="(v) => !v && (deleteShift = null)"
        />
    </div>
</template>
