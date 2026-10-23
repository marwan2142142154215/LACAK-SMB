<script setup>
import {
    Building2,
    FileSignature,
    LogOut,
    MapPinned,
    Menu,
    PackageOpen,
    Radar,
    Send,
    Settings,
    Smartphone,
    Users,
    Video,
    X,
} from '@lucide/vue'
import dayjs from 'dayjs'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useTelemetry } from '@/composables/useTelemetry'
import { useAuthStore } from '@/stores/auth'
import { useLiveStore } from '@/stores/live'

const auth = useAuthStore()
const live = useLiveStore()
const router = useRouter()
const route = useRoute()
const loggingOut = ref(false)
const telemetry = useTelemetry()

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
        ],
    },
    {
        label: 'Perangkat',
        items: [
            { to: { name: 'devices' }, label: 'Device', icon: Smartphone },
            { to: { name: 'geofence-rules' }, label: 'Aturan geofence', icon: MapPinned },
            { to: { name: 'consent-documents' }, label: 'Dokumen consent', icon: FileSignature },
            { to: { name: 'apk-builds' }, label: 'Build APK', icon: PackageOpen },
        ],
    },
    {
        label: 'Akses',
        items: [
            { to: { name: 'telegram-bindings' }, label: 'Bot Telegram', icon: Send },
            { to: { name: 'organizations' }, label: 'Site', icon: Building2, hidden: !auth.isSuperAdmin },
            { to: { name: 'staff' }, label: 'Staf', icon: Users, hidden: !auth.isSuperAdmin },
            { to: { name: 'settings' }, label: 'Pengaturan', icon: Settings, hidden: !auth.isSuperAdmin },
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
onMounted(() => (clockTimer = setInterval(() => (now.value = dayjs()), 1000)))
onBeforeUnmount(() => clearInterval(clockTimer))

const readouts = computed(() => [
    { label: 'Site', value: telemetry.sites.value },
    {
        label: 'Online',
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
        led: telemetry.liveCount.value ? 'text-danger-400' : 'text-base-500 led-off',
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
            class="fixed inset-y-0 left-0 z-50 flex w-60 shrink-0 flex-col border-r border-base-800 bg-base-900 transition-transform duration-200 lg:sticky lg:top-0 lg:h-dvh lg:!translate-x-0"
            :class="mobileNavOpen ? 'translate-x-0' : '-translate-x-full'"
        >
            <div class="flex h-16 items-center justify-between gap-2 px-5">
                <router-link
                    :to="{ name: 'radar' }"
                    class="flex items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-accent-400"
                >
                    <!-- Logo = radar mini yang menyapu, sama dengan halaman masuk -->
                    <span
                        class="brand-mark relative size-8 shrink-0 overflow-hidden rounded-full border border-base-700"
                        aria-hidden="true"
                    >
                        <span class="absolute inset-[5px] rounded-full border border-dashed border-base-700" />
                        <span class="brand-sweep absolute inset-0 rounded-full" />
                        <span class="absolute top-1/2 left-1/2 size-1 -translate-1/2 rounded-full bg-accent-300" />
                    </span>
                    <span class="leading-tight">
                        <span class="block font-mono text-[13px] font-medium tracking-[0.16em] text-base-50 uppercase">Lacak SMB</span>
                        <span class="eyebrow block !text-[9.5px] !text-base-500">Panel operasi</span>
                    </span>
                </router-link>
                <button
                    type="button"
                    class="rounded-md p-1 text-base-500 hover:text-base-100 lg:hidden"
                    aria-label="Tutup menu"
                    @click="mobileNavOpen = false"
                >
                    <X class="size-5" />
                </button>
            </div>

            <nav class="flex-1 space-y-6 overflow-y-auto px-3 py-4" aria-label="Menu utama">
                <div v-for="group in navGroups" :key="group.label">
                    <p class="eyebrow mb-1.5 px-3 !text-base-500">{{ group.label }}</p>
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
                            class="nav-link group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm text-base-400 transition-colors hover:bg-base-850 hover:text-base-100 focus-visible:outline-2 focus-visible:outline-accent-400"
                            exact-active-class="is-active"
                        >
                            <component :is="item.icon" class="nav-icon size-[17px] shrink-0" />
                            {{ item.label }}
                            <span v-if="item.live" class="ml-auto font-mono text-[10px] tracking-wider text-danger-400">LIVE</span>
                        </router-link>
                    </template>
                </div>
            </nav>

            <div class="border-t border-base-800 p-3">
                <div class="flex items-center gap-3 rounded-md px-2 py-2">
                    <div
                        class="flex size-9 shrink-0 items-center justify-center rounded-md bg-base-800 font-mono text-sm font-medium text-copper-400"
                    >
                        {{ auth.user?.name?.charAt(0)?.toUpperCase() ?? '?' }}
                    </div>
                    <div class="min-w-0 flex-1">
                        <p class="truncate text-sm font-medium text-base-100">{{ auth.user?.name }}</p>
                        <p class="truncate text-xs text-base-500">{{ roleLabel }}</p>
                    </div>
                    <button
                        type="button"
                        aria-label="Keluar"
                        title="Keluar"
                        class="flex size-8 items-center justify-center rounded-md text-base-500 transition-colors hover:bg-danger-500/10 hover:text-danger-400 focus-visible:outline-2 focus-visible:outline-accent-400"
                        :disabled="loggingOut"
                        @click="handleLogout"
                    >
                        <LogOut class="size-4" />
                    </button>
                </div>
            </div>
        </aside>

        <div class="flex min-w-0 flex-1 flex-col">
            <!-- Strip telemetri: angka kunci yang berlaku di semua halaman -->
            <div class="sticky top-0 z-30 flex h-12 items-center gap-4 border-b border-base-800 bg-base-950/85 px-4 backdrop-blur sm:px-8">
                <button
                    type="button"
                    class="-ml-1 rounded-md p-1 text-base-300 hover:text-base-50 lg:hidden"
                    aria-label="Buka menu"
                    @click="mobileNavOpen = true"
                >
                    <Menu class="size-5" />
                </button>
                <dl
                    class="flex min-w-0 flex-1 items-center gap-5 overflow-x-auto font-mono text-[11px] tracking-[0.12em] uppercase sm:gap-7"
                >
                    <template v-for="item in readouts" :key="item.label">
                        <div v-if="!item.hidden" class="flex shrink-0 items-center gap-2">
                            <span v-if="item.led" class="led" :class="item.led" />
                            <dt class="text-base-500">{{ item.label }}</dt>
                            <dd class="text-base-100 tabular-nums">{{ item.value ?? '—' }}</dd>
                        </div>
                    </template>
                </dl>
                <p class="hidden shrink-0 font-mono text-[11px] tracking-[0.12em] text-base-400 uppercase tabular-nums md:block">
                    {{ now.format('ddd DD MMM') }} <span class="ml-2 text-base-100">{{ now.format('HH:mm:ss') }}</span>
                </p>
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

            <main class="min-w-0 flex-1">
                <router-view />
            </main>
        </div>
    </div>
</template>

<style scoped>
.nav-link.is-active {
    background-color: var(--color-base-850);
    color: var(--color-base-50);
}

/* Penanda halaman aktif: garis teal di tepi kiri, seperti lampu pilihan panel */
.nav-link.is-active::before {
    content: '';
    position: absolute;
    left: -0.75rem;
    top: 0.5rem;
    bottom: 0.5rem;
    width: 2px;
    border-radius: 0 2px 2px 0;
    background-color: var(--color-accent-400);
}

.nav-link.is-active .nav-icon {
    color: var(--color-accent-400);
}

.brand-sweep {
    background: conic-gradient(from 0deg, transparent 0deg 270deg, color-mix(in oklab, var(--color-accent-400) 45%, transparent) 360deg);
    animation: brand-sweep 6s linear infinite;
}

@keyframes brand-sweep {
    to {
        transform: rotate(1turn);
    }
}

@media (prefers-reduced-motion: reduce) {
    .brand-sweep {
        animation: none;
    }
}
</style>
