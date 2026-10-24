<script setup>
import { Camera, MonitorOff, Signal, SignalLow, SignalMedium } from '@lucide/vue'
import { computed } from 'vue'

import LiveVideoTile from '@/components/live/LiveVideoTile.vue'
import { formatElapsed, useNow } from '@/composables/useNow'
import { workStatus } from '@/lib/workStatus'

// Satu staf = satu bingkai dua sisi: layar kerjanya + kamera yang menghadap
// dia. `swapped` menukar posisi kiri/kanan untuk semua bingkai sekaligus.
const props = defineProps({
    name: { type: String, required: true },
    screenTrack: { type: Object, default: null },
    cameraTrack: { type: Object, default: null },
    status: { type: String, default: null },
    since: { type: [Date, String, Number], default: null },
    // excellent | good | poor | lost | unknown (ConnectionQuality LiveKit)
    quality: { type: String, default: null },
    swapped: { type: Boolean, default: false },
    mirrorCamera: { type: Boolean, default: false },
    large: { type: Boolean, default: false },
})

const now = useNow()
const meta = computed(() => (props.status ? workStatus(props.status) : null))
const elapsed = computed(() => (props.since ? formatElapsed(props.since, now.value) : null))

const qualityMeta = computed(
    () =>
        ({
            excellent: { icon: Signal, label: 'Koneksi bagus', tone: 'text-emerald-400' },
            good: { icon: SignalMedium, label: 'Koneksi cukup', tone: 'text-yellow-400' },
            poor: { icon: SignalLow, label: 'Koneksi lemah -- kualitas diturunkan otomatis', tone: 'text-orange-400' },
            lost: { icon: SignalLow, label: 'Koneksi putus', tone: 'text-red-500' },
        })[props.quality] ?? null,
)

const sides = computed(() => {
    const screen = { key: 'screen', label: 'Layar', track: props.screenTrack }
    const camera = { key: 'camera', label: 'Kamera', track: props.cameraTrack }
    return props.swapped ? [camera, screen] : [screen, camera]
})
</script>

<template>
    <div class="overflow-hidden rounded-xl border border-base-800 bg-base-900">
        <div class="flex items-center gap-2.5 px-3 py-2" :class="large && 'px-4 py-3'">
            <span class="min-w-0 flex-1 truncate text-sm font-medium text-base-50" :class="large && 'font-display text-lg'">{{
                name
            }}</span>
            <span
                v-if="meta"
                class="inline-flex shrink-0 items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-[0.1em] uppercase"
                :class="meta.chip"
            >
                <span class="led" :class="[meta.led, status === 'alert' && 'motion-safe:animate-pulse']" />
                {{ meta.label }}
            </span>
            <component
                :is="qualityMeta.icon"
                v-if="qualityMeta"
                class="size-4 shrink-0"
                :class="qualityMeta.tone"
                :title="qualityMeta.label"
            />
            <span v-if="elapsed" class="shrink-0 font-mono text-[11px] text-base-400 tabular-nums">{{ elapsed }}</span>
        </div>

        <div class="grid gap-px bg-base-800 sm:grid-cols-2">
            <div v-for="side in sides" :key="side.key" class="relative bg-black">
                <LiveVideoTile
                    v-if="side.track"
                    :track="side.track"
                    :label="side.label"
                    :fit="side.key === 'screen' || large ? 'contain' : 'cover'"
                    :mirrored="side.key === 'camera' && mirrorCamera"
                    class="!rounded-none !border-0"
                />
                <div v-else class="flex aspect-video flex-col items-center justify-center gap-2 bg-base-900 text-base-500">
                    <MonitorOff v-if="side.key === 'screen'" class="size-6" />
                    <Camera v-else class="size-6" />
                    <span class="font-mono text-[10.5px] tracking-[0.14em] uppercase">
                        {{ side.key === 'screen' ? 'Layar tidak dibagikan' : 'Kamera mati' }}
                    </span>
                </div>
            </div>
        </div>
    </div>
</template>
