<script setup>
import { Copy, RefreshCw, ShieldAlert } from '@lucide/vue'
import { animate, createDrawable, createTimeline, splitText, stagger, utils } from 'animejs'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import BaseButton from '@/components/ui/BaseButton.vue'
import { useToast } from '@/composables/useToast'
import { checkIpAccess } from '@/lib/ipAccess'

/**
 * Pengganti halaman login untuk IP di luar whitelist (Pengaturan -> Whitelist
 * IP). Bahasa visualnya radar yang sama dengan halaman login: jaringan kantor
 * adalah lingkaran jangkauan, dan titik perangkat ini ada di luarnya.
 */
const RECHECK_SECONDS = 30

const router = useRouter()
const toast = useToast()

const ip = ref('')
const checking = ref(false)
const unreachable = ref(false)
const countdown = ref(RECHECK_SECONDS)

const root = ref(null)
const heading = ref(null)

// Posisi "Anda": di luar lingkaran jaringan kantor (r = 60), arah timur laut.
const PERIMETER = 60
const YOU = { angle: 52, r: 84 }
const rad = (deg) => (deg * Math.PI) / 180
const you = { x: Math.sin(rad(YOU.angle)) * YOU.r, y: -Math.cos(rad(YOU.angle)) * YOU.r }
const edge = { x: Math.sin(rad(YOU.angle)) * PERIMETER, y: -Math.cos(rad(YOU.angle)) * PERIMETER }

const ticks = Array.from({ length: 48 }, (_, i) => {
    const angle = i * 7.5
    const major = i % 4 === 0
    const inner = PERIMETER + 4
    const outer = inner + (major ? 4 : 2)
    return {
        angle,
        major,
        x1: Math.sin(rad(angle)) * inner,
        y1: -Math.cos(rad(angle)) * inner,
        x2: Math.sin(rad(angle)) * outer,
        y2: -Math.cos(rad(angle)) * outer,
    }
})

const countdownLabel = computed(() => (checking.value ? 'Memeriksa…' : `Diperiksa ulang otomatis dalam ${countdown.value} dtk`))

async function recheck({ manual = false } = {}) {
    if (checking.value) return
    checking.value = true
    const result = await checkIpAccess({ fresh: true })
    checking.value = false
    countdown.value = RECHECK_SECONDS

    if (!result) {
        unreachable.value = true
        if (manual) toast.error('Server tidak bisa dihubungi', 'Periksa koneksi internet, lalu coba lagi.')
        return
    }
    unreachable.value = false
    ip.value = result.ip
    if (result.allowed) {
        toast.success('Jaringan terdaftar', 'Silakan masuk.')
        router.replace({ name: 'login' })
    } else if (manual) {
        toast.error('Masih di luar jaringan terdaftar', `IP ${result.ip} belum ada di whitelist.`)
    }
}

async function copyIp() {
    try {
        await navigator.clipboard.writeText(ip.value)
        toast.success('IP disalin', 'Kirim ke super admin untuk didaftarkan.')
    } catch {
        toast.error('Gagal menyalin', 'Salin manual dari layar')
    }
}

let ticker = null
let intro = null
let pulse = null
let marching = null
let split = null

function playIntro() {
    const el = root.value
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    split = splitText(heading.value, { chars: true })
    const fades = el.querySelectorAll('[data-fade]')
    utils.set([...fades, ...split.chars, el.querySelectorAll('.tick'), el.querySelector('.you'), el.querySelector('.gap')], {
        opacity: 0,
    })

    intro = createTimeline({ defaults: { ease: 'outQuart' } })
        .add(createDrawable(el.querySelectorAll('.ring')), { draw: ['0 0', '0 1'], duration: 900, delay: stagger(140) })
        .add(createDrawable(el.querySelector('.perimeter')), { draw: ['0 0', '0 1'], duration: 1100, ease: 'inOutQuad' }, '-=500')
        .add(el.querySelectorAll('.tick'), { opacity: [0, 1], duration: 300, delay: stagger(12) }, '-=800')
        .add(createDrawable(el.querySelector('.reach')), { draw: ['0 0', '0 1'], duration: 600 }, '-=300')
        .add(el.querySelector('.gap'), { opacity: [0, 1], duration: 400 })
        .add(el.querySelector('.you'), { opacity: [0, 1], scale: [0, 1], duration: 600, ease: 'outBack(2)' }, '-=200')
        .add(split.chars, { opacity: [0, 1], y: ['0.45em', '0em'], duration: 650, delay: stagger(18) }, 200)
        .add(fades, { opacity: [0, 1], y: [12, 0], duration: 700, delay: stagger(90) }, 650)

    // Denyut titik "Anda" & garis putus-putus yang terus "mencari" sinyal.
    pulse = animate(el.querySelectorAll('.you-pulse'), {
        scale: [1, 3.2],
        opacity: [0.55, 0],
        duration: 2200,
        delay: stagger(1100),
        loop: true,
        ease: 'outSine',
    })
    marching = animate(el.querySelector('.gap'), { strokeDashoffset: [0, -12], duration: 900, loop: true, ease: 'linear' })
}

onMounted(async () => {
    const result = await checkIpAccess()
    if (result?.allowed) return router.replace({ name: 'login' })
    ip.value = result?.ip ?? ''
    unreachable.value = !result

    await nextTick()
    playIntro()

    ticker = setInterval(() => {
        if (checking.value) return
        countdown.value -= 1
        if (countdown.value <= 0) recheck()
    }, 1000)
})

onBeforeUnmount(() => {
    clearInterval(ticker)
    intro?.revert()
    pulse?.revert()
    marching?.revert()
    split?.revert()
})
</script>

<template>
    <div ref="root" class="grid min-h-dvh bg-base-950 lg:grid-cols-[minmax(0,1.1fr)_minmax(26rem,1fr)]">
        <!-- Instrumen: jangkauan jaringan kantor, perangkat ini di luar lingkaran -->
        <section
            class="relative isolate flex flex-col overflow-hidden border-b border-base-800 bg-base-900 px-6 pt-6 pb-8 sm:px-10 lg:border-r lg:border-b-0 lg:py-10"
        >
            <div class="flex items-center justify-between text-[12px] font-semibold text-base-400">
                <span><span class="text-base-50">Lacak</span> SMB</span>
                <span class="hidden sm:inline">Whitelist IP</span>
            </div>

            <div class="mx-auto my-6 w-[min(100%,20rem)] sm:w-[min(100%,24rem)] lg:my-auto lg:w-[min(100%,32rem,calc(100dvh-16rem))]">
                <svg viewBox="-100 -100 200 200" class="block size-full overflow-visible" aria-hidden="true">
                    <circle class="ring stroke-base-700" r="20" fill="none" stroke-width="0.5" />
                    <circle class="ring stroke-base-700" r="40" fill="none" stroke-width="0.5" />
                    <circle class="perimeter stroke-accent-400" :r="PERIMETER" fill="none" stroke-width="0.9" />
                    <circle :r="PERIMETER" class="fill-accent-400/5" />
                    <line
                        v-for="tick in ticks"
                        :key="tick.angle"
                        class="tick"
                        :class="tick.major ? 'stroke-base-500' : 'stroke-base-700'"
                        :x1="tick.x1"
                        :y1="tick.y1"
                        :x2="tick.x2"
                        :y2="tick.y2"
                        stroke-width="0.5"
                    />
                    <text :x="0" :y="-PERIMETER - 13" text-anchor="middle" class="fill-accent-300 font-mono" font-size="4.2">
                        JARINGAN KANTOR
                    </text>

                    <!-- Jangkauan kantor berhenti di tepi lingkaran -->
                    <line class="reach stroke-accent-400" x1="0" y1="0" :x2="edge.x" :y2="edge.y" stroke-width="0.7" />
                    <line
                        class="gap stroke-danger-400"
                        :x1="edge.x"
                        :y1="edge.y"
                        :x2="you.x"
                        :y2="you.y"
                        stroke-width="0.7"
                        stroke-dasharray="2 4"
                    />
                    <circle r="2.2" class="fill-accent-300" />

                    <g :transform="`translate(${you.x} ${you.y})`">
                        <g class="you">
                            <circle class="you-pulse fill-danger-400" r="2.6" />
                            <circle class="you-pulse fill-danger-400" r="2.6" />
                            <circle r="2.6" class="fill-danger-400" />
                            <text x="5.5" y="1.4" class="fill-danger-400 font-mono" font-size="4.2">ANDA</text>
                        </g>
                    </g>
                </svg>
            </div>

            <p class="flex items-center gap-2 text-[12px] font-semibold" role="status">
                <span class="size-1.5 rounded-full bg-danger-400" />
                <span class="text-base-500">Status</span>
                <span class="text-base-200">Di luar jaringan terdaftar</span>
            </p>
        </section>

        <main class="flex items-center justify-center px-6 py-10 sm:px-10">
            <div class="w-full max-w-md">
                <p data-fade class="flex items-center gap-2 text-[12px] font-semibold tracking-wide text-danger-400 uppercase">
                    <ShieldAlert class="size-4" /> Akses dibatasi
                </p>
                <h1
                    ref="heading"
                    class="mt-3 font-display text-[2rem] leading-[1.05] font-extrabold tracking-[-0.03em] text-balance text-base-50 sm:text-4xl"
                >
                    Jaringan ini di luar jangkauan.
                </h1>
                <p data-fade class="mt-4 text-sm text-pretty text-base-400">
                    Lacak SMB hanya bisa dibuka dari jaringan yang didaftarkan kantor. Perangkat Anda tersambung dari alamat di bawah, yang
                    belum termasuk daftar itu.
                </p>

                <div data-fade class="mt-6 flex items-center gap-3 rounded-xl border border-base-800 bg-base-900 px-4 py-3">
                    <div class="min-w-0 flex-1">
                        <p class="text-[11px] font-semibold text-base-500">IP Anda</p>
                        <p class="mt-0.5 truncate font-mono text-lg text-base-50 tabular-nums">{{ ip || '—' }}</p>
                    </div>
                    <BaseButton v-if="ip" variant="ghost" size="icon" aria-label="Salin IP" @click="copyIp">
                        <Copy class="size-4" />
                    </BaseButton>
                </div>

                <ul data-fade class="mt-6 space-y-3 text-sm text-pretty text-base-300">
                    <li class="flex gap-3">
                        <span class="mt-2 size-1.5 shrink-0 rounded-full bg-base-500" />
                        <span
                            >Sambungkan perangkat ke Wi-Fi atau jaringan kantor, lalu tekan
                            <strong class="text-base-50">Periksa lagi</strong>.</span
                        >
                    </li>
                    <li class="flex gap-3">
                        <span class="mt-2 size-1.5 shrink-0 rounded-full bg-base-500" />
                        <span>Sudah di kantor tapi masih tertahan? Kirim IP di atas ke super admin supaya didaftarkan.</span>
                    </li>
                </ul>

                <div data-fade class="mt-8 flex flex-wrap items-center gap-x-4 gap-y-3">
                    <BaseButton :loading="checking" @click="recheck({ manual: true })">
                        <RefreshCw class="size-4" /> Periksa lagi
                    </BaseButton>
                    <span class="text-xs text-base-500" aria-live="polite">{{ countdownLabel }}</span>
                </div>
                <p v-if="unreachable" data-fade class="mt-4 text-xs text-warning-400">
                    Server sedang tidak bisa dihubungi, jadi status IP belum bisa dipastikan.
                </p>
            </div>
        </main>
    </div>
</template>

<style scoped>
/* Skala titik denyut dari pusatnya sendiri, bukan dari titik asal SVG. */
.you,
.you-pulse {
    transform-box: fill-box;
    transform-origin: center;
}
</style>
