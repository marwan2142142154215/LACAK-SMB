<script setup>
import { Building2, FileSignature, LogOut, MapPinned, Menu, PackageOpen, Radar, Send, ShieldCheck, Smartphone, Users, X } from '@lucide/vue'
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const loggingOut = ref(false)

// Sidebar jadi drawer di layar sempit (standar 9.3: wajib bisa dipakai di
// ponsel) — mobileNavOpen mengontrol tampil/sembunyi, ditutup otomatis
// setiap kali pindah halaman.
const mobileNavOpen = ref(false)
watch(
    () => route.fullPath,
    () => (mobileNavOpen.value = false),
)

const navItems = [
    { to: { name: 'radar' }, label: 'Radar', icon: Radar },
    { to: { name: 'devices' }, label: 'Device', icon: Smartphone },
    { to: { name: 'consent-documents' }, label: 'Dokumen Consent', icon: FileSignature },
    { to: { name: 'geofence-rules' }, label: 'Aturan Geofence', icon: MapPinned },
    { to: { name: 'apk-builds' }, label: 'APK Builds', icon: PackageOpen },
    { to: { name: 'telegram-bindings' }, label: 'Bot Telegram', icon: Send },
]

async function handleLogout() {
    loggingOut.value = true
    try {
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
    <div class="flex min-h-screen bg-base-950">
        <!-- Overlay gelap di belakang drawer saat terbuka (mobile) -->
        <div v-if="mobileNavOpen" class="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden" @click="mobileNavOpen = false" />

        <!--
            Transform mobile dipisah sebagai SATU class dinamis (bukan
            dua class -translate-x-full/translate-x-0 digabung dengan
            v-bind:class object) — Tailwind mengurutkan utility berdasar
            posisinya di stylesheet yang di-generate, bukan urutan di atribut
            class, jadi dua utility transform yang saling bertentangan aktif
            bersamaan membuat kondisi v-if/class diam-diam tidak berefek.
        -->
        <aside
            class="fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-base-800 bg-base-900/95 backdrop-blur transition-transform duration-200 lg:static lg:!translate-x-0 lg:bg-base-900/60"
            :class="mobileNavOpen ? 'translate-x-0' : '-translate-x-full'"
        >
            <div class="flex items-center justify-between gap-2.5 border-b border-base-800 px-5 py-5">
                <div class="flex items-center gap-2.5">
                    <div class="flex size-9 items-center justify-center rounded-lg bg-accent-500/15 ring-1 ring-accent-500/30">
                        <ShieldCheck class="size-5 text-accent-400" />
                    </div>
                    <div>
                        <p class="text-sm font-semibold tracking-wide text-base-50">Lacak Master</p>
                        <p class="text-[11px] text-base-500">Panel Kontrol</p>
                    </div>
                </div>
                <button type="button" class="text-base-500 lg:hidden" @click="mobileNavOpen = false">
                    <X class="size-5" />
                </button>
            </div>

            <nav class="flex-1 space-y-1 overflow-y-auto px-3 py-4">
                <!--
                    Pakai exact-active-class (bukan active-class): active-class
                    bawaan Vue Router mencocokkan prefix path, jadi link Radar
                    (path "/") ikut ter-highlight di SEMUA halaman lain karena
                    setiap path diawali "/". exact-active-class memastikan hanya
                    route yang benar-benar aktif yang disorot.
                -->
                <router-link
                    v-for="item in navItems"
                    :key="item.label"
                    :to="item.to"
                    class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-base-400 transition-colors hover:bg-base-800 hover:text-base-100"
                    exact-active-class="!bg-accent-500/10 !text-accent-300"
                >
                    <component :is="item.icon" class="size-[18px]" />
                    {{ item.label }}
                </router-link>

                <router-link
                    v-if="auth.isSuperAdmin"
                    :to="{ name: 'organizations' }"
                    class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-base-400 transition-colors hover:bg-base-800 hover:text-base-100"
                    exact-active-class="!bg-accent-500/10 !text-accent-300"
                >
                    <Building2 class="size-[18px]" />
                    Site / Organisasi
                </router-link>

                <router-link
                    v-if="auth.isSuperAdmin"
                    :to="{ name: 'staff' }"
                    class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-base-400 transition-colors hover:bg-base-800 hover:text-base-100"
                    exact-active-class="!bg-accent-500/10 !text-accent-300"
                >
                    <Users class="size-[18px]" />
                    Staf
                </router-link>
            </nav>

            <div class="border-t border-base-800 p-3">
                <div class="flex items-center gap-3 rounded-lg px-3 py-2.5">
                    <div
                        class="flex size-9 shrink-0 items-center justify-center rounded-full bg-base-800 text-sm font-semibold text-base-200"
                    >
                        {{ auth.user?.name?.charAt(0) ?? '?' }}
                    </div>
                    <div class="min-w-0 flex-1">
                        <p class="truncate text-sm font-medium text-base-100">{{ auth.user?.name }}</p>
                        <p class="truncate text-xs text-base-500">{{ auth.user?.roles?.join(', ') }}</p>
                    </div>
                    <button
                        type="button"
                        title="Keluar"
                        class="flex size-8 items-center justify-center rounded-lg text-base-500 transition-colors hover:bg-danger-500/10 hover:text-danger-400"
                        :disabled="loggingOut"
                        @click="handleLogout"
                    >
                        <LogOut class="size-4" />
                    </button>
                </div>
            </div>
        </aside>

        <div class="flex min-w-0 flex-1 flex-col">
            <!-- Topbar hamburger, hanya tampil di bawah breakpoint lg -->
            <div class="flex items-center gap-3 border-b border-base-800 bg-base-900/40 px-4 py-3 lg:hidden">
                <button type="button" class="text-base-300" @click="mobileNavOpen = true">
                    <Menu class="size-5" />
                </button>
                <p class="text-sm font-semibold text-base-100">Lacak Master</p>
            </div>

            <main class="min-w-0 flex-1 overflow-y-auto">
                <router-view />
            </main>
        </div>
    </div>
</template>
