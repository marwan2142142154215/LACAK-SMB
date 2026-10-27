<script setup>
import {
    CalendarClock,
    ClipboardList,
    Mic,
    MicOff,
    MonitorUp,
    MonitorX,
    PhoneOff,
    Presentation,
    Search,
    Square,
    Users,
    Video,
    VideoOff,
    Wallpaper,
    X,
} from '@lucide/vue'
import dayjs from 'dayjs'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import BackgroundPicker from '@/components/live/BackgroundPicker.vue'
import LiveVideoTile from '@/components/live/LiveVideoTile.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import { backgroundSupported, useBriefingCall } from '@/composables/useBriefingCall'
import { formatElapsed, useNow } from '@/composables/useNow'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

// Daftar briefing dimuat ulang berkala selama tidak sedang di dalam panggilan.
const REFRESH_MS = 20_000

const route = useRoute()
const auth = useAuthStore()
const toast = useToast()
const now = useNow()
const call = useBriefingCall()

const items = ref([])
const canHost = ref(false)
const roleOptions = ref([])
const siteOptions = ref([])
const peopleOptions = ref([])
const upcoming = ref([])
const recent = ref([])
const recurrenceOptions = ref([])
const loaded = ref(false)
const current = ref(null) // briefing yang sedang diikuti
let refreshTimer = null

const startOpen = ref(false)
const starting = ref(false)
// mode 'roles' = undang menurut peran & site; 'people' = pilih orangnya langsung.
const form = ref({ title: '', mode: 'roles', roles: ['staff_viewer'], sites: [], people: [], when: 'now', ...defaultSchedule() })
const peopleQuery = ref('')
const filteredPeople = computed(() => {
    const query = peopleQuery.value.trim().toLowerCase()
    if (!query) return peopleOptions.value
    return peopleOptions.value.filter((person) =>
        [person.name, person.role, person.site].some((value) => value?.toLowerCase().includes(query)),
    )
})
// Jadwal default: besok jam 08:00, hari kerja, 30 menit.
function defaultSchedule() {
    return { date: dayjs().add(1, 'day').format('YYYY-MM-DD'), time: '08:00', recurrence: 'once', duration: 30 }
}
const WHEN_MODES = [
    { value: 'now', label: 'Mulai sekarang' },
    { value: 'later', label: 'Jadwalkan' },
]
const DURATIONS = [15, 30, 45, 60, 90, 120]
const INVITE_MODES = [
    { value: 'roles', label: 'Menurut peran & site' },
    { value: 'people', label: 'Pilih orang' },
]
// Briefing yang akan diakhiri (dari dalam panggilan atau dari kartunya).
const endTarget = ref(null)
const ending = ref(false)

const roleLabel = (value) => roleOptions.value.find((role) => role.value === value)?.label ?? value

async function load() {
    try {
        const { data } = await api.get('/briefings', { params: { with_people: 1 } })
        items.value = data.data.items
        canHost.value = data.data.can_host
        roleOptions.value = data.data.roles
        siteOptions.value = data.data.sites
        peopleOptions.value = data.data.people ?? []
        upcoming.value = data.data.upcoming ?? []
        recent.value = data.data.recent ?? []
        recurrenceOptions.value = data.data.recurrences ?? []
        loaded.value = true
    } catch (err) {
        toast.error('Gagal memuat briefing', err.response?.data?.message)
    }
}

function openStart() {
    form.value = {
        title: '',
        mode: 'roles',
        roles: ['staff_viewer'],
        sites: siteOptions.value.map((site) => site.id),
        people: [],
        when: 'now',
        ...defaultSchedule(),
    }
    peopleQuery.value = ''
    startOpen.value = true
}

function toggleIn(list, value) {
    const index = list.indexOf(value)
    if (index >= 0) list.splice(index, 1)
    else list.push(value)
}

async function startBriefing() {
    const byPeople = form.value.mode === 'people'
    if (byPeople && !form.value.people.length) return toast.error('Pilih peserta', 'Minimal satu orang harus diundang.')
    if (!byPeople && !form.value.roles.length) return toast.error('Pilih peran', 'Minimal satu peran harus diundang.')
    starting.value = true
    try {
        const allSites = form.value.sites.length === siteOptions.value.length
        const later = form.value.when === 'later'
        const { data } = await api.post('/briefings', {
            title: form.value.title,
            ...(byPeople
                ? { user_ids: form.value.people }
                : { roles: form.value.roles, organization_ids: allSites ? [] : form.value.sites }),
            ...(later
                ? {
                      schedule: {
                          date: form.value.date,
                          time: form.value.time,
                          recurrence: form.value.recurrence,
                          duration_minutes: Number(form.value.duration),
                      },
                  }
                : {}),
        })
        startOpen.value = false
        if (later) {
            toast.success(
                'Briefing dijadwalkan',
                `${form.value.title} · ${dayjs(data.data.schedule.next_run_at).format('dddd, D MMM HH:mm')}`,
            )
            load()
            return
        }
        await enter(data.data, true)
    } catch (err) {
        toast.error('Gagal memulai briefing', err.response?.data?.message ?? err.message)
    } finally {
        starting.value = false
    }
}

async function joinBriefing(briefing) {
    try {
        const { data } = await api.post(`/briefings/${briefing.id}/join`)
        await enter(data.data, data.data.briefing.is_host)
    } catch (err) {
        toast.error('Gagal bergabung', err.response?.data?.message ?? err.message)
        load()
    }
}

// Detak kehadiran selama di dalam ruang (daftar hadir), tiap 30 detik.
const PRESENCE_MS = 30_000
let presenceTimer = null
function startPresence(briefingId) {
    stopPresence()
    const ping = () => api.post(`/briefings/${briefingId}/presence`).catch(() => {})
    ping()
    presenceTimer = setInterval(ping, PRESENCE_MS)
}
function stopPresence() {
    clearInterval(presenceTimer)
    presenceTimer = null
}

async function enter(connection, asHost) {
    current.value = connection.briefing
    try {
        await call.join(connection, { asHost, cameraOn: connection.briefing.camera_on_join })
        startPresence(connection.briefing.id)
    } catch (err) {
        current.value = null
        throw err
    }
}

async function leaveBriefing() {
    stopPresence()
    await call.leave()
    current.value = null
    load()
}

// ===== Jadwal & daftar hadir =====
const cancelTarget = ref(null)
const cancelling = ref(false)
async function cancelSchedule() {
    cancelling.value = true
    try {
        await api.delete(`/briefing-schedules/${cancelTarget.value.id}`)
        toast.success('Jadwal dibatalkan', cancelTarget.value.title)
        load()
    } catch (err) {
        toast.error('Jadwal belum dibatalkan', err.response?.data?.message)
    } finally {
        cancelling.value = false
        cancelTarget.value = null
    }
}

const attendanceOpen = ref(false)
const attendance = ref(null)
const loadingAttendance = ref(false)
async function openAttendance(briefing) {
    attendanceOpen.value = true
    attendance.value = null
    loadingAttendance.value = true
    try {
        const { data } = await api.get(`/briefings/${briefing.id}/attendance`)
        attendance.value = data.data
    } catch (err) {
        attendanceOpen.value = false
        toast.error('Gagal memuat daftar hadir', err.response?.data?.message)
    } finally {
        loadingAttendance.value = false
    }
}

const durationLabel = (seconds) => {
    const minutes = Math.round(seconds / 60)
    return minutes >= 60 ? `${Math.floor(minutes / 60)}j ${minutes % 60}m` : `${minutes}m`
}

function whenLabel(at) {
    const day = dayjs(at)
    if (day.isSame(dayjs(), 'day')) return `Hari ini, ${day.format('HH:mm')}`
    if (day.isSame(dayjs().add(1, 'day'), 'day')) return `Besok, ${day.format('HH:mm')}`
    return day.format('dddd, D MMM · HH:mm')
}

async function endBriefing() {
    const target = endTarget.value
    ending.value = true
    try {
        await api.post(`/briefings/${target.id}/end`)
        if (current.value?.id === target.id) {
            stopPresence()
            await call.leave()
            current.value = null
        }
        toast.success('Briefing diakhiri', 'Semua peserta sudah dikeluarkan.')
        load()
    } catch (err) {
        toast.error('Gagal mengakhiri briefing', err.response?.data?.message)
    } finally {
        ending.value = false
        endTarget.value = null
    }
}

async function runToggle(action, failTitle) {
    try {
        await action()
    } catch (err) {
        toast.error(failTitle, err.message)
    }
}

// Pemimpin mengakhiri briefing -> room dihapus server.
watch(
    () => call.endedByHost.value,
    (ended) => {
        if (!ended || !current.value) return
        toast.info('Briefing selesai', 'Pemimpin mengakhiri briefing.')
        stopPresence()
        current.value = null
        load()
    },
)

const inCall = computed(() => !!call.room.value)
const isHost = computed(() => !!current.value?.is_host)
const gridClass = computed(() => {
    const count = call.participants.value.length
    if (count <= 1) return 'grid-cols-1 max-w-3xl mx-auto'
    if (count <= 4) return 'grid-cols-1 sm:grid-cols-2'
    if (count <= 9) return 'grid-cols-2 lg:grid-cols-3'
    return 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-4'
})

// Ganti background kamera (blur / gambar) -- hanya di briefing.
const canChangeBackground = ref(false)
const backgroundOpen = ref(false)
const applyingBackground = ref(false)

async function chooseBackground(value) {
    applyingBackground.value = true
    try {
        await call.setBackground(value)
        if (value.mode !== 'none' && !call.local.value.cameraOn) {
            toast.info('Background tersimpan', 'Dipakai begitu kamera dinyalakan.')
        }
    } catch (err) {
        toast.error('Background belum bisa dipasang', err.message)
    } finally {
        applyingBackground.value = false
    }
}

onMounted(async () => {
    backgroundSupported().then((supported) => (canChangeBackground.value = supported))
    await load()
    // Tautan "Gabung" dari banner: /briefing?join=ID
    const joinId = Number(route.query.join)
    const target = items.value.find((briefing) => briefing.id === joinId)
    if (target) joinBriefing(target)
    refreshTimer = setInterval(() => {
        if (!inCall.value) load()
    }, REFRESH_MS)
})
onBeforeUnmount(() => {
    clearInterval(refreshTimer)
    stopPresence()
})
</script>

<template>
    <div>
        <!-- ===== Di dalam panggilan ===== -->
        <div v-if="inCall" class="flex min-h-[calc(100dvh-5.5rem)] flex-col px-4 pt-5 pb-4 sm:px-8">
            <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div class="min-w-0">
                    <p class="eyebrow flex items-center gap-2">
                        <span class="beacon" />
                        Briefing berlangsung
                    </p>
                    <h1 class="truncate font-display text-2xl font-extrabold tracking-[-0.03em] text-base-50">{{ current?.title }}</h1>
                </div>
                <span
                    class="inline-flex items-center gap-2 rounded-full bg-base-900 px-3 py-1.5 text-sm font-semibold text-base-300 shadow-(--shadow-card)"
                >
                    <Users class="size-4" />
                    {{ call.participants.value.length }} peserta
                </span>
            </div>

            <!-- Presentasi (layar pemimpin) besar, peserta di sampingnya -->
            <div v-if="call.screenShare.value" class="grid flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_16rem]">
                <div class="overflow-hidden rounded-2xl bg-black">
                    <LiveVideoTile
                        :track="call.screenShare.value.track"
                        :label="`Layar ${call.screenShare.value.participant.name}`"
                        fit="contain"
                        bare
                        class="!rounded-none !border-0"
                    />
                </div>
                <div class="grid content-start gap-2 overflow-y-auto sm:grid-cols-3 lg:grid-cols-1">
                    <div
                        v-for="participant in call.participants.value"
                        :key="participant.identity"
                        class="relative aspect-video overflow-hidden rounded-xl bg-[#0e1520]"
                        :class="participant.isSpeaking && 'ring-2 ring-accent-500'"
                    >
                        <LiveVideoTile
                            v-if="call.cameraOf(participant)"
                            :track="call.cameraOf(participant)"
                            :label="participant.name || participant.identity"
                            :mirrored="participant === call.room.value.localParticipant"
                            bare
                            class="!rounded-none !border-0"
                        />
                        <span class="absolute bottom-1.5 left-2 truncate text-xs font-semibold text-white">{{ participant.name }}</span>
                    </div>
                </div>
            </div>

            <!-- Grid peserta -->
            <div v-else class="grid flex-1 content-start gap-3" :class="gridClass">
                <div
                    v-for="participant in call.participants.value"
                    :key="participant.identity"
                    class="relative aspect-video overflow-hidden rounded-2xl bg-[#0e1520] transition-shadow"
                    :class="participant.isSpeaking && 'ring-2 ring-accent-500 ring-offset-2 ring-offset-base-950'"
                >
                    <LiveVideoTile
                        v-if="call.cameraOf(participant)"
                        :track="call.cameraOf(participant)"
                        :label="participant.name || participant.identity"
                        :mirrored="participant === call.room.value.localParticipant"
                        bare
                        class="!rounded-none !border-0"
                    />
                    <div v-else class="flex size-full items-center justify-center">
                        <span
                            class="flex size-16 items-center justify-center rounded-full bg-white/10 font-display text-2xl font-extrabold text-white"
                        >
                            {{ (participant.name || '?').charAt(0).toUpperCase() }}
                        </span>
                    </div>
                    <div
                        class="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-3 pt-6 pb-2"
                    >
                        <span class="truncate text-sm font-semibold text-white">
                            {{ participant.name || participant.identity }}
                            <template v-if="participant === call.room.value.localParticipant"> (Anda)</template>
                        </span>
                        <component
                            :is="call.micOn(participant) ? Mic : MicOff"
                            class="ml-auto size-4 shrink-0"
                            :class="call.micOn(participant) ? 'text-white' : 'text-white/50'"
                        />
                    </div>
                </div>
            </div>

            <!-- Dok kendali -->
            <div
                class="sticky bottom-4 mx-auto mt-5 flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-base-800 bg-base-900/90 p-2 shadow-(--shadow-raised) backdrop-blur"
                role="toolbar"
                aria-label="Kendali briefing"
            >
                <BaseButton
                    :variant="call.local.value.micOn ? 'outline' : 'primary'"
                    :aria-pressed="call.local.value.micOn"
                    @click="runToggle(call.toggleMic, 'Mikrofon belum menyala')"
                >
                    <component :is="call.local.value.micOn ? Mic : MicOff" class="size-4" />
                    {{ call.local.value.micOn ? 'Bisukan' : 'Nyalakan mikrofon' }}
                </BaseButton>
                <BaseButton
                    :variant="call.local.value.cameraOn ? 'outline' : 'primary'"
                    :aria-pressed="call.local.value.cameraOn"
                    @click="runToggle(call.toggleCamera, 'Kamera belum menyala')"
                >
                    <component :is="call.local.value.cameraOn ? VideoOff : Video" class="size-4" />
                    {{ call.local.value.cameraOn ? 'Matikan kamera' : 'Nyalakan kamera' }}
                </BaseButton>
                <BaseButton v-if="canChangeBackground" variant="outline" @click="backgroundOpen = true">
                    <Wallpaper class="size-4" />
                    Background
                </BaseButton>
                <BaseButton
                    v-if="isHost"
                    variant="outline"
                    :aria-pressed="call.local.value.screenOn"
                    @click="runToggle(call.toggleScreen, 'Layar belum dibagikan')"
                >
                    <component :is="call.local.value.screenOn ? MonitorX : MonitorUp" class="size-4" />
                    {{ call.local.value.screenOn ? 'Hentikan presentasi' : 'Presentasikan layar' }}
                </BaseButton>
                <BaseButton variant="ghost" @click="leaveBriefing">
                    <PhoneOff class="size-4" />
                    Keluar
                </BaseButton>
                <BaseButton v-if="isHost || auth.isSuperAdmin" variant="outline" @click="openAttendance(current)">
                    <ClipboardList class="size-4" />
                    Daftar hadir
                </BaseButton>
                <BaseButton v-if="isHost" variant="danger" @click="endTarget = current">
                    <Square class="size-4" />
                    Akhiri untuk semua
                </BaseButton>
            </div>
        </div>

        <!-- ===== Daftar briefing ===== -->
        <template v-else>
            <PageHeader
                eyebrow="Pantau"
                title="Briefing"
                subtitle="Rapat video dalam satu ruang. Pemimpin memilih peran dan site yang diundang; hanya mereka yang bisa bergabung."
            >
                <template v-if="canHost" #actions>
                    <BaseButton :loading="call.connecting.value" @click="openStart">
                        <Presentation class="size-4" />
                        Briefing baru
                    </BaseButton>
                </template>
            </PageHeader>

            <div class="p-4 sm:p-8">
                <div v-if="!loaded" class="py-12 text-center text-sm text-base-500">Memuat briefing…</div>
                <div v-else-if="!items.length" class="rounded-2xl border border-base-800 bg-base-900 shadow-(--shadow-card)">
                    <EmptyState
                        :icon="Presentation"
                        title="Belum ada briefing yang berlangsung"
                        :description="
                            canHost
                                ? 'Tekan Briefing baru untuk memulai sekarang atau menjadwalkannya.'
                                : 'Briefing yang mengundang Anda muncul di sini, dan pemberitahuannya tampil di atas setiap halaman.'
                        "
                    />
                </div>
                <ul v-else class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    <li
                        v-for="briefing in items"
                        :key="briefing.id"
                        class="flex flex-col rounded-2xl border border-base-800 bg-base-900 p-5 shadow-(--shadow-card)"
                    >
                        <p class="eyebrow flex items-center gap-2">
                            <span class="beacon" />
                            Berlangsung {{ formatElapsed(briefing.started_at, now) }}
                            <span v-if="briefing.planned_end_at" class="font-normal normal-case"
                                >· terjadwal s/d {{ dayjs(briefing.planned_end_at).format('HH:mm') }}</span
                            >
                        </p>
                        <h2 class="mt-2 font-display text-xl font-extrabold tracking-[-0.025em] text-base-50">{{ briefing.title }}</h2>
                        <p class="mt-1 text-sm text-base-400">Dipimpin {{ briefing.is_host ? 'Anda' : (briefing.host_name ?? '—') }}</p>
                        <p v-if="briefing.invited?.length" class="mt-3 text-sm text-pretty text-base-300">
                            <Users class="mr-1 inline size-4 align-[-3px] text-base-500" />
                            {{ briefing.invited.join(', ') }}
                        </p>
                        <div v-else class="mt-3 flex flex-wrap gap-1.5">
                            <span
                                v-for="role in briefing.roles"
                                :key="role"
                                class="rounded-full bg-base-850 px-2.5 py-0.5 text-xs font-semibold text-base-300"
                                >{{ roleLabel(role) }}</span
                            >
                            <span class="rounded-full bg-copper-500/12 px-2.5 py-0.5 text-xs font-semibold text-copper-400">
                                {{ briefing.sites.length ? briefing.sites.join(', ') : 'Semua site' }}
                            </span>
                        </div>
                        <div class="mt-5 flex gap-2">
                            <BaseButton class="flex-1" :loading="call.connecting.value" @click="joinBriefing(briefing)">
                                <Video class="size-4" />
                                Gabung
                            </BaseButton>
                            <BaseButton
                                v-if="briefing.is_host || auth.isSuperAdmin"
                                variant="outline"
                                size="icon"
                                :aria-label="`Daftar hadir ${briefing.title}`"
                                title="Daftar hadir"
                                @click="openAttendance(briefing)"
                            >
                                <ClipboardList class="size-4" />
                            </BaseButton>
                            <!-- Pemimpin & root bisa mengakhiri tanpa masuk ke panggilan. -->
                            <BaseButton v-if="briefing.is_host || auth.isSuperAdmin" variant="danger" @click="endTarget = briefing">
                                <Square class="size-4" />
                                Akhiri
                            </BaseButton>
                        </div>
                    </li>
                </ul>

                <!-- Mendatang -->
                <section v-if="upcoming.length" class="mt-8">
                    <h2 class="eyebrow mb-3 flex items-center gap-2"><CalendarClock class="size-3.5" /> Mendatang</h2>
                    <ul
                        class="divide-y divide-base-800 overflow-hidden rounded-2xl border border-base-800 bg-base-900 shadow-(--shadow-card)"
                    >
                        <li v-for="schedule in upcoming" :key="schedule.id" class="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-4">
                            <div class="w-44 shrink-0">
                                <p class="font-display text-[15px] font-bold text-base-50">{{ whenLabel(schedule.next_run_at) }}</p>
                                <p class="text-xs text-base-500">{{ schedule.recurrence_label }} · {{ schedule.duration_minutes }} menit</p>
                            </div>
                            <div class="min-w-0 flex-1">
                                <p class="truncate font-semibold text-base-100">{{ schedule.title }}</p>
                                <p class="truncate text-sm text-base-400">
                                    Dipimpin {{ schedule.is_host ? 'Anda' : (schedule.host_name ?? '—') }} ·
                                    {{
                                        schedule.invited.length
                                            ? schedule.invited.join(', ')
                                            : `${schedule.roles.map(roleLabel).join(', ')} · ${schedule.sites.length ? schedule.sites.join(', ') : 'Semua site'}`
                                    }}
                                </p>
                            </div>
                            <BaseButton v-if="schedule.can_cancel" size="sm" variant="ghost" @click="cancelTarget = schedule">
                                <X class="size-4" />
                                Batalkan
                            </BaseButton>
                        </li>
                    </ul>
                </section>

                <!-- Riwayat (pemimpin) -->
                <section v-if="recent.length" class="mt-8">
                    <h2 class="eyebrow mb-3">Riwayat 14 hari</h2>
                    <ul
                        class="divide-y divide-base-800 overflow-hidden rounded-2xl border border-base-800 bg-base-900 shadow-(--shadow-card)"
                    >
                        <li v-for="briefing in recent" :key="briefing.id" class="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3.5">
                            <div class="min-w-0 flex-1">
                                <p class="truncate font-semibold text-base-100">{{ briefing.title }}</p>
                                <p class="text-sm text-base-400">
                                    {{ dayjs(briefing.started_at).format('ddd, D MMM HH:mm') }}–{{
                                        dayjs(briefing.ended_at).format('HH:mm')
                                    }}
                                    ·
                                    {{ briefing.host_name ?? '—' }}
                                </p>
                            </div>
                            <span class="font-mono text-sm text-base-300 tabular-nums">{{ briefing.attendee_count }} hadir</span>
                            <BaseButton size="sm" variant="outline" @click="openAttendance(briefing)">
                                <ClipboardList class="size-4" />
                                Daftar hadir
                            </BaseButton>
                        </li>
                    </ul>
                </section>
            </div>
        </template>

        <BaseDialog
            :open="startOpen"
            title="Briefing baru"
            description="Mulai sekarang atau jadwalkan. Undang menurut peran & site, atau pilih orangnya langsung."
            @update:open="(v) => (startOpen = v)"
        >
            <form id="briefing-form" class="space-y-5" @submit.prevent="startBriefing">
                <BaseInput v-model="form.title" label="Judul" placeholder="Contoh: Briefing pagi shift A" required maxlength="120" />
                <div class="grid grid-cols-2 gap-1 rounded-xl bg-base-850 p-1" role="radiogroup" aria-label="Kapan">
                    <button
                        v-for="option in WHEN_MODES"
                        :key="option.value"
                        type="button"
                        role="radio"
                        :aria-checked="form.when === option.value"
                        class="rounded-lg px-3 py-2 text-sm font-semibold transition-colors"
                        :class="
                            form.when === option.value
                                ? 'bg-base-900 text-base-50 shadow-(--shadow-card)'
                                : 'text-base-400 hover:text-base-200'
                        "
                        @click="form.when = option.value"
                    >
                        {{ option.label }}
                    </button>
                </div>
                <div v-if="form.when === 'later'" class="grid grid-cols-2 gap-3 rounded-xl border border-base-800 p-3">
                    <BaseInput v-model="form.date" type="date" label="Tanggal" required :min="dayjs().format('YYYY-MM-DD')" />
                    <BaseInput v-model="form.time" type="time" label="Jam" required />
                    <BaseSelect v-model="form.recurrence" label="Ulangi">
                        <option v-for="option in recurrenceOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                    </BaseSelect>
                    <BaseSelect v-model="form.duration" label="Durasi">
                        <option v-for="minutes in DURATIONS" :key="minutes" :value="minutes">{{ minutes }} menit</option>
                    </BaseSelect>
                    <p class="col-span-2 text-xs text-pretty text-base-500">
                        Peserta diingatkan 10 menit sebelumnya (banner dashboard & Telegram site). Pada jamnya briefing terbuka dan bisa
                        langsung digabung; ditutup otomatis setelah durasinya bila ruang sudah kosong.
                    </p>
                </div>
                <div class="grid grid-cols-2 gap-1 rounded-xl bg-base-850 p-1" role="radiogroup" aria-label="Cara mengundang">
                    <button
                        v-for="option in INVITE_MODES"
                        :key="option.value"
                        type="button"
                        role="radio"
                        :aria-checked="form.mode === option.value"
                        class="rounded-lg px-3 py-2 text-sm font-semibold transition-colors"
                        :class="
                            form.mode === option.value
                                ? 'bg-base-900 text-base-50 shadow-(--shadow-card)'
                                : 'text-base-400 hover:text-base-200'
                        "
                        @click="form.mode = option.value"
                    >
                        {{ option.label }}
                    </button>
                </div>
                <fieldset v-if="form.mode === 'people'">
                    <legend class="field-label">Peserta ({{ form.people.length }} dipilih)</legend>
                    <label class="relative block">
                        <span class="sr-only">Cari nama, peran, atau site</span>
                        <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                        <input v-model="peopleQuery" type="search" placeholder="Cari nama, peran, atau site" class="field-control pl-9" />
                    </label>
                    <ul class="mt-2 max-h-64 overflow-y-auto rounded-xl border border-base-800">
                        <li v-for="person in filteredPeople" :key="person.id">
                            <label class="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-base-850">
                                <input
                                    type="checkbox"
                                    class="size-4 accent-accent-500"
                                    :checked="form.people.includes(person.id)"
                                    @change="toggleIn(form.people, person.id)"
                                />
                                <span class="min-w-0 flex-1">
                                    <span class="block truncate text-sm font-medium text-base-100">{{ person.name }}</span>
                                    <span class="block truncate text-xs text-base-500">{{
                                        [person.role, person.site].filter(Boolean).join(' · ')
                                    }}</span>
                                </span>
                            </label>
                        </li>
                        <li v-if="!filteredPeople.length" class="px-3 py-4 text-center text-sm text-base-500">Tidak ada yang cocok.</li>
                    </ul>
                    <p class="field-hint">
                        Hanya yang dipilih yang bisa bergabung, dan semua masuk dengan kamera menyala sehingga saling melihat.
                    </p>
                </fieldset>
                <fieldset v-if="form.mode === 'roles'">
                    <legend class="field-label">Peran yang diundang</legend>
                    <div class="flex flex-wrap gap-2">
                        <label
                            v-for="role in roleOptions"
                            :key="role.value"
                            class="inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors"
                            :class="
                                form.roles.includes(role.value)
                                    ? 'border-transparent bg-base-50 text-base-950'
                                    : 'border-base-700 text-base-300 hover:border-base-600'
                            "
                        >
                            <input
                                type="checkbox"
                                class="sr-only"
                                :checked="form.roles.includes(role.value)"
                                @change="toggleIn(form.roles, role.value)"
                            />
                            {{ role.label }}
                        </label>
                    </div>
                </fieldset>
                <fieldset v-if="form.mode === 'roles' && siteOptions.length">
                    <legend class="field-label">Site yang diundang</legend>
                    <div class="flex flex-wrap gap-2">
                        <label
                            v-for="site in siteOptions"
                            :key="site.id"
                            class="inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors"
                            :class="
                                form.sites.includes(site.id)
                                    ? 'border-transparent bg-copper-500/15 text-copper-400'
                                    : 'border-base-700 text-base-300 hover:border-base-600'
                            "
                        >
                            <input
                                type="checkbox"
                                class="sr-only"
                                :checked="form.sites.includes(site.id)"
                                @change="toggleIn(form.sites, site.id)"
                            />
                            {{ site.name }}
                        </label>
                    </div>
                    <p class="field-hint">Semua dicentang = semua site yang Anda pegang.</p>
                </fieldset>
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="startOpen = false">Batal</BaseButton>
                <BaseButton
                    type="submit"
                    form="briefing-form"
                    :loading="starting"
                    :disabled="form.mode === 'people' ? !form.people.length : !form.sites.length && siteOptions.length > 0"
                >
                    <component :is="form.when === 'later' ? CalendarClock : Presentation" class="size-4" />
                    {{ form.when === 'later' ? 'Jadwalkan briefing' : 'Mulai briefing' }}
                </BaseButton>
            </template>
        </BaseDialog>

        <BackgroundPicker
            :open="backgroundOpen"
            :value="call.background.value"
            :applying="applyingBackground"
            description="Untuk briefing. Diproses di komputer Anda; peserta lain melihat hasilnya."
            @update:open="(v) => (backgroundOpen = v)"
            @select="chooseBackground"
        />

        <BaseDialog
            :open="attendanceOpen"
            :title="attendance ? `Daftar hadir: ${attendance.briefing.title}` : 'Daftar hadir'"
            :description="
                attendance
                    ? `${dayjs(attendance.briefing.started_at).format('ddd, D MMM HH:mm')}${attendance.briefing.ended_at ? `–${dayjs(attendance.briefing.ended_at).format('HH:mm')}` : ' · masih berlangsung'}`
                    : ''
            "
            size="lg"
            @update:open="(v) => (attendanceOpen = v)"
        >
            <p v-if="loadingAttendance" class="text-sm text-base-500">Memuat daftar hadir…</p>
            <template v-else-if="attendance">
                <p class="text-sm text-base-300">
                    <span class="font-semibold text-base-50">{{ attendance.attended.length }}</span> hadir dari
                    {{ attendance.expected_count }} undangan ·
                    <span :class="attendance.absent.length && 'text-danger-400'">{{ attendance.absent.length }} tidak hadir</span>
                </p>
                <h3 class="eyebrow mt-4 mb-2">Hadir</h3>
                <p v-if="!attendance.attended.length" class="text-sm text-base-500">Belum ada peserta yang bergabung.</p>
                <ul v-else class="divide-y divide-base-800">
                    <li v-for="row in attendance.attended" :key="row.user_id" class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                        <span class="min-w-0 flex-1 truncate text-sm font-medium text-base-100">
                            {{ row.name }} <span v-if="row.site" class="font-normal text-base-500">· {{ row.site }}</span>
                        </span>
                        <span class="font-mono text-xs text-base-400 tabular-nums"
                            >masuk {{ dayjs(row.first_joined_at).format('HH:mm') }}</span
                        >
                        <span class="font-mono text-xs text-base-400 tabular-nums">{{ durationLabel(row.seconds) }}</span>
                        <span v-if="row.late" class="text-xs font-semibold text-warning-400">terlambat</span>
                        <span v-if="row.inside" class="flex items-center gap-1 text-xs font-semibold text-st-working"
                            ><span class="led" /> di ruang</span
                        >
                    </li>
                </ul>
                <template v-if="attendance.absent.length">
                    <h3 class="eyebrow mt-5 mb-2">Tidak hadir</h3>
                    <p class="text-sm text-pretty text-base-400">
                        {{ attendance.absent.map((row) => row.name).join(', ') }}
                    </p>
                </template>
            </template>
        </BaseDialog>

        <ConfirmDialog
            :open="!!cancelTarget"
            :title="`Batalkan jadwal ${cancelTarget?.title ?? ''}?`"
            :description="
                cancelTarget?.recurrence === 'once'
                    ? 'Briefing ini tidak akan dibuka.'
                    : 'Semua briefing berikutnya dari jadwal ini dibatalkan.'
            "
            confirm-label="Batalkan jadwal"
            :loading="cancelling"
            @confirm="cancelSchedule"
            @update:open="(v) => !v && (cancelTarget = null)"
        />

        <ConfirmDialog
            :open="!!endTarget"
            :title="`Akhiri briefing ${endTarget?.title ?? ''}?`"
            description="Semua peserta langsung dikeluarkan dari ruang briefing."
            confirm-label="Akhiri briefing"
            :loading="ending"
            @confirm="endBriefing"
            @update:open="(v) => !v && (endTarget = null)"
        />
    </div>
</template>
