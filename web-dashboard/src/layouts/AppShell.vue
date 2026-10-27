<script setup>
import {
    Activity,
    Building2,
    CalendarClock,
    CalendarOff,
    Film,
    History,
    LogOut,
    MapPinned,
    Megaphone,
    Menu,
    MessagesSquare,
    Moon,
    PackageOpen,
    Presentation,
    Radar,
    ScanFace,
    Send,
    ServerCog,
    Settings,
    Smartphone,
    Sun,
    Users,
    Video,
    X,
} from '@lucide/vue'
import dayjs from 'dayjs'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import ChatWidget from '@/components/chat/ChatWidget.vue'
import CameraLock from '@/components/live/CameraLock.vue'
import ScreenShareLock from '@/components/live/ScreenShareLock.vue'
import { useTelemetry } from '@/composables/useTelemetry'
import { useTheme } from '@/composables/useTheme'
import api from '@/lib/api'
import { refreshWorkCounters, workCountersVersion } from '@/lib/workCounters'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useLiveStore } from '@/stores/live'

const auth = useAuthStore()
// Admin & leader membuka halaman Staf hanya untuk menonaktifkan staf di site-nya.
const canSeeStaff = computed(() => auth.isSuperAdmin || ['admin', 'leader'].some((role) => auth.user?.roles?.includes(role)))
const live = useLiveStore()
const chat = useChatStore()
const toast = useToast()
const router = useRouter()
const route = useRoute()
const loggingOut = ref(false)
const telemetry = useTelemetry()
const { theme, toggleTheme } = useTheme()

// Sidebar jadi drawer di layar sempit (standar 9.3: wajib bisa dipakai di
// ponsel) — mobileNavOpen mengontrol tampil/sembunyi, ditutup otomatis
// setiap kali pindah halaman.
const mobileNavOpen = ref(false)
watch(
    () => route.fullPath,
    () => (mobileNavOpen.value = false),
)

// Dikelompokkan menurut pekerjaan operator: memantau, mengurus perangkat,
// dan mengatur siapa yang punya akses.
const navGroups = computed(() => [
    {
        label: 'Pantau',
        items: [
            { to: { name: 'radar' }, label: 'Radar', icon: Radar },
            { to: { name: 'live' }, label: 'Live Kerja', icon: Video, live: live.isBroadcasting },
            { to: { name: 'briefing' }, label: 'Briefing', icon: Presentation, live: briefings.value.length > 0 },
            { to: { name: 'activity' }, label: 'Aktivitas user', icon: Activity, hidden: !auth.hasPermission('live.watch') },
            { to: { name: 'face-log' }, label: 'Log wajah hilang', icon: ScanFace, hidden: !auth.hasPermission('live.watch') },
            { to: { name: 'recordings' }, label: 'Rekaman', icon: Film, hidden: !auth.hasPermission('live.watch') },
        ],
    },
    {
        label: 'Kerja',
        items: [
            { to: { name: 'chat' }, label: 'Chat', icon: MessagesSquare, count: chat.totalUnread },
            { to: { name: 'attendance' }, label: 'Absensi', icon: CalendarClock },
            { to: { name: 'leave' }, label: 'Izin & cuti', icon: CalendarOff, count: leavePending.value },
            { to: { name: 'announcements' }, label: 'Pengumuman', icon: Megaphone, count: announcementUnread.value },
        ],
    },
    {
        label: 'Perangkat',
        items: [
            { to: { name: 'devices' }, label: 'Device', icon: Smartphone },
            { to: { name: 'geofence-rules' }, label: 'Aturan geofence', icon: MapPinned },
            { to: { name: 'apk-builds' }, label: 'Build APK', icon: PackageOpen, hidden: !auth.hasPermission('apk-builds.manage') },
        ],
    },
    {
        label: 'Akses',
        items: [
            { to: { name: 'telegram-bindings' }, label: 'Bot Telegram', icon: Send },
            { to: { name: 'organizations' }, label: 'Site', icon: Building2, hidden: !auth.isSuperAdmin },
            { to: { name: 'staff' }, label: 'Staf', icon: Users, hidden: !canSeeStaff.value },
            { to: { name: 'activity-logs' }, label: 'Log aktivitas', icon: History, hidden: !auth.hasPermission('activity-logs.view') },
            { to: { name: 'settings' }, label: 'Pengaturan', icon: Settings, hidden: !auth.isSuperAdmin },
            { to: { name: 'server-status' }, label: 'Status server', icon: ServerCog, hidden: !auth.isSuperAdmin },
        ],
    },
])

const ROLE_LABELS = {
    super_admin: 'Super Admin',
    admin: 'Admin',
    leader: 'Leader',
    site_admin: 'Admin Site',
    staff_viewer: 'Staf',
}
const roleLabel = computed(() => (auth.user?.roles ?? []).map((role) => ROLE_LABELS[role] ?? role).join(', '))

const now = ref(dayjs())
let clockTimer = null
onMounted(() => {
    clockTimer = setInterval(() => (now.value = dayjs()), 1000)
    // Floating chat staf: tersambung selama dashboard terbuka, di semua halaman.
    chat.start()
    // Refresh saat sedang siaran: sambung lagi otomatis di halaman mana pun.
    live.resumeIfBroadcasting().then(({ resumed, error }) => {
        if (resumed) toast.success('Siaran dilanjutkan', 'Kamera Anda tersiar lagi setelah halaman dimuat ulang.')
        // Sesi berakhir (401) / IP ditolak: interceptor sudah menampilkan pesannya.
        else if (error && auth.isAuthenticated)
            toast.error('Siaran belum tersambung lagi', `${error.message} Buka Live Kerja lalu tekan Lanjutkan siaran.`)
    })
})
onBeforeUnmount(() => clearInterval(clockTimer))

// Briefing yang mengundang user ini: banner "Gabung" di semua halaman.
const BRIEFING_POLL_MS = 60_000
const briefings = ref([])
const upcomingBriefings = ref([])
let briefingTimer = null
async function loadBriefings() {
    try {
        const { data } = await api.get('/briefings')
        briefings.value = data.data.items
        upcomingBriefings.value = data.data.upcoming ?? []
    } catch {
        // Diam saja: banner hanya bantuan, halaman Briefing tetap bisa dibuka.
    }
}
const briefingInvite = computed(() => (route.name === 'briefing' ? null : (briefings.value.find((briefing) => !briefing.is_host) ?? null)))
// Briefing terjadwal yang mulai dalam 15 menit (pengingat sebelum dibuka).
const BRIEFING_SOON_MS = 15 * 60_000
const briefingSoon = computed(() => {
    if (route.name === 'briefing' || briefingInvite.value) return null
    return (
        upcomingBriefings.value.find((schedule) => {
            const left = dayjs(schedule.next_run_at).diff(now.value)
            return left > 0 && left <= BRIEFING_SOON_MS
        }) ?? null
    )
})
const minutesUntil = (at) => Math.max(1, Math.ceil(dayjs(at).diff(now.value) / 60_000))

// Pengumuman belum dibaca & pengajuan izin yang menunggu (angka di menu, banner).
const announcementUnread = ref(0)
const latestAnnouncement = ref(null)
const leavePending = ref(0)
const isManager = computed(() => ['super_admin', 'admin', 'leader', 'site_admin'].some((role) => auth.user?.roles?.includes(role)))
async function loadWorkCounters() {
    try {
        const { data } = await api.get('/announcements')
        announcementUnread.value = data.data.unread_count
        latestAnnouncement.value = data.data.items.find((item) => !item.is_read) ?? null
    } catch {
        // Banner hanya bantuan.
    }
    if (!isManager.value) return
    try {
        const { data } = await api.get('/leave-requests')
        leavePending.value = data.data.pending_count
    } catch {
        // Angka di menu hanya bantuan.
    }
}
const announcementBanner = computed(() => (route.name === 'announcements' ? null : latestAnnouncement.value))
async function dismissAnnouncement() {
    const item = latestAnnouncement.value
    latestAnnouncement.value = null
    try {
        await api.post(`/announcements/${item.id}/read`)
    } finally {
        refreshWorkCounters()
    }
}

onMounted(() => {
    loadBriefings()
    loadWorkCounters()
    briefingTimer = setInterval(() => {
        loadBriefings()
        loadWorkCounters()
    }, BRIEFING_POLL_MS)
})
onBeforeUnmount(() => clearInterval(briefingTimer))
watch(
    () => route.name,
    () => {
        loadBriefings()
        loadWorkCounters()
    },
)
watch(workCountersVersion, loadWorkCounters)

const readouts = computed(() => [
    { label: 'Site', value: telemetry.sites.value },
    // Staf yang sedang login (Online atau sedang kerja) / semua staf.
    {
        label: 'Staf online',
        value: telemetry.staffTotal.value == null ? null : `${telemetry.staffOnline.value}/${telemetry.staffTotal.value}`,
        led: telemetry.staffOnline.value ? 'text-st-online' : 'text-base-500 led-off',
    },
    {
        label: 'Device online',
        value: telemetry.devicesTotal.value == null ? null : `${telemetry.devicesOnline.value}/${telemetry.devicesTotal.value}`,
        led: 'text-accent-400',
    },
    {
        label: 'Terkunci',
        value: telemetry.devicesLocked.value,
        led: telemetry.devicesLocked.value ? 'text-danger-400' : 'text-base-500 led-off',
    },
    {
        label: 'Live',
        value: telemetry.liveCount.value,
        led: 'text-base-500 led-off',
        beacon: telemetry.liveCount.value > 0,
        hidden: !auth.hasPermission('live.watch'),
    },
])

async function handleLogout() {
    loggingOut.value = true
    try {
        // Logout = selesai kerja juga -- jangan tinggalkan kamera menyiarkan
        // atas nama akun yang sudah keluar.
        if (live.isBroadcasting) await live.endWork().catch(() => {})
        await live.disconnect()
        chat.stop()
        await auth.logout()
        router.push({ name: 'login' })
    } catch {
        auth.clearSession()
        router.push({ name: 'login' })
    } finally {
        loggingOut.value = false
    }
}
</script>

<template>
    <div class="flex min-h-dvh bg-base-950">
        <!-- Overlay gelap di belakang drawer saat terbuka (mobile) -->
        <div v-if="mobileNavOpen" class="fixed inset-0 z-40 bg-base-950/80 backdrop-blur-sm lg:hidden" @click="mobileNavOpen = false" />

        <!--
            Transform mobile dipisah sebagai SATU class dinamis (bukan
            dua class -translate-x-full/translate-x-0 digabung dengan
            v-bind:class object) — Tailwind mengurutkan utility berdasar
            posisinya di stylesheet yang di-generate, bukan urutan di atribut
            class, jadi dua utility transform yang saling bertentangan aktif
            bersamaan membuat kondisi v-if/class diam-diam tidak berefek.
        -->
        <aside
            class="fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col p-3 transition-transform duration-200 lg:sticky lg:top-0 lg:h-dvh lg:!translate-x-0"
            :class="mobileNavOpen ? 'translate-x-0' : '-translate-x-full'"
        >
            <div class="flex min-h-0 flex-1 flex-col rounded-2xl border border-base-800 bg-base-900 shadow-(--shadow-card)">
                <div class="flex h-16 items-center justify-between gap-2 px-4">
                    <router-link
                        :to="{ name: 'radar' }"
                        class="flex items-center gap-3 rounded-xl focus-visible:outline-2 focus-visible:outline-accent-500"
                    >
                        <!-- Logo: beacon oranye di atas tinta -- sinyal yang sedang dipantau -->
                        <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-base-50" aria-hidden="true">
                            <span class="beacon" />
                        </span>
                        <span class="leading-tight">
                            <span class="block font-display text-[15px] font-extrabold tracking-[-0.02em] text-base-50">Lacak SMB</span>
                            <span class="block text-xs text-base-500">Pusat pantau</span>
                        </span>
                    </router-link>
                    <button
                        type="button"
                        class="rounded-lg p-1 text-base-500 hover:text-base-100 lg:hidden"
                        aria-label="Tutup menu"
                        @click="mobileNavOpen = false"
                    >
                        <X class="size-5" />
                    </button>
                </div>

                <nav class="flex-1 space-y-5 overflow-y-auto px-3 pt-2 pb-4" aria-label="Menu utama">
                    <div v-for="group in navGroups" :key="group.label">
                        <p class="mb-1 px-3 text-[11px] font-semibold text-base-500">{{ group.label }}</p>
                        <!--
                            Pakai exact-active-class (bukan active-class): active-class
                            bawaan Vue Router mencocokkan prefix path, jadi link Radar
                            (path "/") ikut ter-highlight di SEMUA halaman lain karena
                            setiap path diawali "/". exact-active-class memastikan hanya
                            route yang benar-benar aktif yang disorot.
                        -->
                        <template v-for="item in group.items" :key="item.label">
                            <router-link
                                v-if="!item.hidden"
                                :to="item.to"
                                class="nav-link group relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-base-400 transition-colors hover:bg-base-850 hover:text-base-100 focus-visible:outline-2 focus-visible:outline-accent-500"
                                exact-active-class="is-active"
                            >
                                <component :is="item.icon" class="nav-icon size-[18px] shrink-0" />
                                {{ item.label }}
                                <span v-if="item.live" class="ml-auto flex items-center gap-1.5 text-[11px] font-bold text-accent-400">
                                    <span class="beacon" />
                                    Live
                                </span>
                                <span
                                    v-else-if="item.count"
                                    class="ml-auto min-w-5 rounded-full bg-accent-500 px-1.5 text-center font-mono text-[11px] leading-5 font-bold text-white tabular-nums"
                                    :aria-label="`${item.count} baru`"
                                    >{{ item.count > 99 ? '99+' : item.count }}</span
                                >
                            </router-link>
                        </template>
                    </div>
                </nav>

                <div class="border-t border-base-800 p-2">
                    <div class="flex items-center gap-3 rounded-xl px-2 py-2">
                        <div
                            class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-copper-500/12 font-display text-sm font-extrabold text-copper-400"
                        >
                            {{ auth.user?.name?.charAt(0)?.toUpperCase() ?? '?' }}
                        </div>
                        <div class="min-w-0 flex-1">
                            <p class="truncate text-sm font-semibold text-base-100">{{ auth.user?.name }}</p>
                            <p class="truncate text-xs text-base-500">{{ roleLabel }}</p>
                        </div>
                        <button
                            type="button"
                            aria-label="Keluar"
                            title="Keluar"
                            class="flex size-8 items-center justify-center rounded-lg text-base-500 transition-colors hover:bg-danger-500/10 hover:text-danger-400 focus-visible:outline-2 focus-visible:outline-accent-500"
                            :disabled="loggingOut"
                            @click="handleLogout"
                        >
                            <LogOut class="size-4" />
                        </button>
                    </div>
                </div>
            </div>
        </aside>

        <div class="flex min-w-0 flex-1 flex-col">
            <!-- Bar status: angka kunci yang berlaku di semua halaman -->
            <div class="sticky top-0 z-30 px-3 pt-3 lg:pl-0">
                <div
                    class="flex h-14 items-center gap-3 rounded-2xl border border-base-800 bg-base-900/85 px-3 shadow-(--shadow-card) backdrop-blur sm:px-4"
                >
                    <button
                        type="button"
                        class="rounded-lg p-1 text-base-300 hover:text-base-50 lg:hidden"
                        aria-label="Buka menu"
                        @click="mobileNavOpen = true"
                    >
                        <Menu class="size-5" />
                    </button>
                    <dl class="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
                        <template v-for="item in readouts" :key="item.label">
                            <div v-if="!item.hidden" class="flex shrink-0 items-center gap-2 rounded-full bg-base-850 px-3 py-1.5 text-xs">
                                <span v-if="item.beacon" class="beacon" />
                                <span v-else-if="item.led" class="led" :class="item.led" />
                                <dt class="font-medium text-base-500">{{ item.label }}</dt>
                                <dd class="font-mono font-medium text-base-50 tabular-nums">{{ item.value ?? '—' }}</dd>
                            </div>
                        </template>
                    </dl>
                    <p class="hidden shrink-0 text-xs font-medium text-base-500 md:block">
                        {{ now.format('ddd, DD MMM') }}
                        <span class="ml-1.5 font-mono text-sm text-base-50 tabular-nums">{{ now.format('HH:mm:ss') }}</span>
                    </p>
                    <button
                        type="button"
                        class="flex size-9 shrink-0 items-center justify-center rounded-xl text-base-400 transition-colors hover:bg-base-850 hover:text-base-50 focus-visible:outline-2 focus-visible:outline-accent-500"
                        :aria-label="theme === 'dark' ? 'Pakai tema terang' : 'Pakai tema gelap'"
                        :title="theme === 'dark' ? 'Tema terang' : 'Tema gelap'"
                        @click="toggleTheme"
                    >
                        <Sun v-if="theme === 'dark'" class="size-4" />
                        <Moon v-else class="size-4" />
                    </button>
                </div>
            </div>

            <!-- Pengingat siaran aktif, tampil di semua halaman selama staf live -->
            <router-link
                v-if="live.isBroadcasting && route.name !== 'live'"
                :to="{ name: 'live' }"
                class="flex items-center gap-2.5 border-b border-danger-500/30 bg-danger-500/10 px-4 py-2 text-xs font-medium text-danger-400 sm:px-8"
            >
                <span class="led animate-pulse" />
                Kamera Anda sedang disiarkan ke rekan se-site. Buka Live Kerja untuk berhenti.
            </router-link>

            <!-- pb-24: ruang untuk tombol chat mengambang supaya tidak menutup baris terakhir -->
            <main class="min-w-0 flex-1" :class="route.name !== 'chat' && 'pb-24'">
                <div
                    v-if="briefingInvite"
                    class="mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-accent-500/30 bg-accent-500/10 px-4 py-3 sm:mx-8"
                    role="status"
                >
                    <span class="beacon" />
                    <p class="min-w-0 flex-1 text-sm text-base-100">
                        <span class="font-semibold">Briefing berlangsung:</span> {{ briefingInvite.title }}
                        <span class="text-base-400">· dipimpin {{ briefingInvite.host_name ?? '—' }}</span>
                    </p>
                    <router-link
                        :to="{ name: 'briefing', query: { join: briefingInvite.id } }"
                        class="inline-flex items-center gap-2 rounded-lg bg-accent-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-accent-600"
                    >
                        <Presentation class="size-4" />
                        Gabung
                    </router-link>
                </div>
                <div
                    v-if="briefingSoon"
                    class="mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-base-700 bg-base-900 px-4 py-3 shadow-(--shadow-card) sm:mx-8"
                    role="status"
                >
                    <Presentation class="size-4 text-accent-500" />
                    <p class="min-w-0 flex-1 text-sm text-base-100">
                        <span class="font-semibold">Briefing {{ briefingSoon.title }}</span> mulai pukul
                        {{ dayjs(briefingSoon.next_run_at).format('HH:mm') }}
                        <span class="text-base-400">· {{ minutesUntil(briefingSoon.next_run_at) }} menit lagi</span>
                    </p>
                    <router-link :to="{ name: 'briefing' }" class="text-sm font-semibold text-accent-500 hover:underline"
                        >Lihat</router-link
                    >
                </div>
                <div
                    v-if="announcementBanner"
                    class="mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 sm:mx-8"
                    :class="
                        announcementBanner.is_important ? 'border-danger-500/40 bg-danger-500/10' : 'border-copper-500/30 bg-copper-500/10'
                    "
                    role="status"
                >
                    <Megaphone class="size-4 shrink-0" :class="announcementBanner.is_important ? 'text-danger-400' : 'text-copper-400'" />
                    <p class="min-w-0 flex-1 text-sm text-base-100">
                        <span class="font-semibold">{{ announcementBanner.title }}</span>
                        <span class="text-base-400"> · {{ announcementBanner.author_name ?? 'Pengumuman' }}</span>
                        <span v-if="announcementUnread > 1" class="text-base-400"> · {{ announcementUnread - 1 }} pengumuman lain</span>
                    </p>
                    <router-link :to="{ name: 'announcements' }" class="text-sm font-semibold text-base-50 hover:underline"
                        >Baca</router-link
                    >
                    <button type="button" class="text-sm font-medium text-base-400 hover:text-base-100" @click="dismissAnnouncement">
                        Sudah dibaca
                    </button>
                </div>
                <router-view />
                <ScreenShareLock />
                <CameraLock />
                <ChatWidget />
            </main>
        </div>
    </div>
</template>

<style scoped>
/* Menu aktif: lapisan oranye tipis, ikon oranye -- sama di tema terang & gelap */
.nav-link.is-active {
    background-color: color-mix(in oklab, var(--color-accent-500) 12%, transparent);
    color: var(--color-base-50);
    font-weight: 600;
}

.nav-link.is-active .nav-icon {
    color: var(--color-accent-500);
}
</style>
