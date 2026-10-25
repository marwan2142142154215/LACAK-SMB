<script setup>
import { Camera, MonitorOff, Signal, SignalLow, SignalMedium } from '@lucide/vue'
import { computed } from 'vue'

import LiveVideoTile from '@/components/live/LiveVideoTile.vue'
import TransportBadge from '@/components/live/TransportBadge.vue'
import { formatElapsed, useNow } from '@/composables/useNow'
import { workStatus } from '@/lib/workStatus'

// Satu staf = satu bingkai dua sisi: layar kerjanya + kamera yang menghadap
// dia. `swapped` menukar posisi kiri/kanan untuk semua bingkai sekaligus.
const props = defineProps({
    name: { type: String, required: true },
    site: { type: String, default: null }, // nama site, diisi di mode "Semua site"
    screenTrack: { type: Object, default: null },
    cameraTrack: { type: Object, default: null },
    status: { type: String, default: null },
    since: { type: [Date, String, Number], default: null },
    // excellent | good | poor | lost | unknown (ConnectionQuality LiveKit)
    quality: { type: String, default: null },
    transport: { type: String, default: null }, // 'udp' | 'tcp'
    swapped: { type: Boolean, default: false },
    mirrorCamera: { type: Boolean, default: false },
    large: { type: Boolean, default: false },
    // Porsi kamera (wajah) terhadap layar kerja:
    // equal = sama besar, small = kamera sempit di samping, corner = kamera kecil di pojok layar
    cameraSize: { type: String, default: 'equal' },
    // Sisakan ruang kanan di kepala bingkai untuk tombol suara yang ditumpuk di atasnya.
    actionInset: { type: Boolean, default: false },
    // Staf sedang bicara (deteksi suara LiveKit) -> bingkai diberi cincin hijau.
    speaking: { type: Boolean, default: false },
})

const now = useNow()
const meta = computed(() => (props.status ? workStatus(props.status) : null))
const elapsed = computed(() => (props.since ? formatElapsed(props.since, now.value) : null))

const qualityMeta = computed(
    () =>
        ({
            excellent: { icon: Signal, label: 'Koneksi bagus', tone: 'text-st-working' },
            good: { icon: SignalMedium, label: 'Koneksi cukup', tone: 'text-st-idle' },
            poor: { icon: SignalLow, label: 'Koneksi lemah -- kualitas diturunkan otomatis', tone: 'text-st-screen' },
            lost: { icon: SignalLow, label: 'Koneksi putus', tone: 'text-st-disconnected' },
        })[props.quality] ?? null,
)

const sides = computed(() => {
    const screen = { key: 'screen', label: 'Layar', track: props.screenTrack }
    const camera = { key: 'camera', label: 'Kamera', track: props.cameraTrack }
    return props.swapped ? [camera, screen] : [screen, camera]
})

// Mode "kecil": layar 3 bagian, kamera 1 bagian (urutannya ikut `swapped`).
const gridClass = computed(() => {
    if (props.cameraSize !== 'small') return 'sm:grid-cols-2'
    return props.swapped ? 'sm:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]' : 'sm:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]'
})
</script>

<template>
    <div
        class="overflow-hidden rounded-xl border bg-base-900 shadow-(--shadow-card) transition-colors"
        :class="speaking ? 'border-st-working ring-1 ring-st-working' : 'border-base-800'"
    >
        <div class="flex items-center gap-2.5 px-3 py-2" :class="[large && 'px-4 py-3', actionInset && 'pr-12']">
            <span class="flex min-w-0 flex-1 items-baseline gap-2">
                <span class="truncate text-sm font-semibold text-base-50" :class="large && 'font-display text-lg'">{{ name }}</span>
                <span v-if="site" class="truncate text-[11px] text-base-500 font-semibold">{{ site }}</span>
            </span>
            <span
                v-if="meta"
                class="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-1.5 py-0.5 text-[11px] font-semibold"
                :class="meta.chip"
            >
                <span class="led" :class="[meta.led, status === 'alert' && 'motion-safe:animate-pulse']" />
                {{ meta.label }}
            </span>
            <TransportBadge :transport="transport" />
            <component
                :is="qualityMeta.icon"
                v-if="qualityMeta"
                class="size-4 shrink-0"
                :class="qualityMeta.tone"
                :title="qualityMeta.label"
            />
            <span v-if="elapsed" class="shrink-0 font-mono text-[11px] text-base-400 tabular-nums">{{ elapsed }}</span>
        </div>

        <!-- Kamera di pojok layar (picture-in-picture). Kalau layar belum
             dibagikan, kamera tampil penuh supaya bingkai tidak kosong. -->
        <div v-if="cameraSize === 'corner'" class="relative bg-black">
            <LiveVideoTile
                v-if="screenTrack || cameraTrack"
                :track="screenTrack ?? cameraTrack"
                :label="screenTrack ? 'Layar' : 'Kamera'"
                :fit="screenTrack || large ? 'contain' : 'cover'"
                :mirrored="!screenTrack && mirrorCamera"
                class="!rounded-none !border-0"
            />
            <div v-else class="flex aspect-video flex-col items-center justify-center gap-2 bg-[#0e1520] text-white/40">
                <MonitorOff class="size-6" />
                <span class="text-[11px] font-semibold">Layar & kamera mati</span>
            </div>
            <LiveVideoTile
                v-if="screenTrack && cameraTrack"
                :track="cameraTrack"
                label="Kamera"
                bare
                fit="cover"
                :mirrored="mirrorCamera"
                class="!absolute bottom-3 w-[26%] min-w-24 !rounded-lg !border-white/25 shadow-lg shadow-black/50"
                :class="swapped ? 'left-3' : 'right-3'"
            />
            <span
                v-if="!screenTrack && cameraTrack"
                class="absolute top-2.5 left-2.5 inline-flex items-center gap-1.5 rounded-full bg-black/65 px-1.5 py-1 text-[11px] text-white/85 backdrop-blur-sm font-semibold"
            >
                <MonitorOff class="size-3" />
                Layar tidak dibagikan
            </span>
        </div>

        <div v-else class="grid gap-px bg-base-800" :class="gridClass">
            <div v-for="side in sides" :key="side.key" class="relative flex items-center bg-black">
                <LiveVideoTile
                    v-if="side.track"
                    :track="side.track"
                    :label="side.label"
                    :bare="side.key === 'camera' && cameraSize === 'small' && !large"
                    :fit="side.key === 'screen' || large ? 'contain' : 'cover'"
                    :mirrored="side.key === 'camera' && mirrorCamera"
                    class="w-full !rounded-none !border-0"
                />
                <div v-else class="flex aspect-video w-full flex-col items-center justify-center gap-2 bg-[#0e1520] text-white/40">
                    <MonitorOff v-if="side.key === 'screen'" class="size-6" />
                    <Camera v-else class="size-6" />
                    <span class="px-2 text-center text-[11px] font-semibold">
                        {{ side.key === 'screen' ? 'Layar tidak dibagikan' : 'Kamera mati' }}
                    </span>
                </div>
            </div>
        </div>
    </div>
</template>
