<script setup>
import { MonitorOff } from '@lucide/vue'
import { computed } from 'vue'

import LiveVideoTile from '@/components/live/LiveVideoTile.vue'
import TransportBadge from '@/components/live/TransportBadge.vue'
import { formatElapsed, useNow } from '@/composables/useNow'
import { workStatus } from '@/lib/workStatus'

// Ubin kecil untuk dinding pantau saat banyak staf live sekaligus: layar
// kerja penuh + kamera kecil di pojok, nama & status ditumpuk di atas
// gambar. Ukuran kecil = adaptiveStream meminta layer resolusi rendah, jadi
// puluhan ubin tetap ringan; detail dilihat lewat popup (klik ubin).
const props = defineProps({
    name: { type: String, required: true },
    site: { type: String, default: null },
    screenTrack: { type: Object, default: null },
    cameraTrack: { type: Object, default: null },
    status: { type: String, default: null },
    since: { type: [Date, String, Number], default: null },
    speaking: { type: Boolean, default: false },
    transport: { type: String, default: null }, // 'udp' | 'tcp'
})

const now = useNow()
const meta = computed(() => (props.status ? workStatus(props.status) : null))
const mainTrack = computed(() => props.screenTrack ?? props.cameraTrack)
const elapsed = computed(() => (props.since ? formatElapsed(props.since, now.value) : null))
</script>

<template>
    <div
        class="relative aspect-video overflow-hidden rounded-xl border bg-black shadow-(--shadow-card) transition-colors"
        :class="speaking ? 'border-st-working ring-1 ring-st-working' : 'border-base-800'"
    >
        <LiveVideoTile
            v-if="mainTrack"
            :track="mainTrack"
            :label="name"
            :fit="screenTrack ? 'contain' : 'cover'"
            bare
            class="!rounded-none !border-0"
        />
        <div v-else class="flex size-full items-center justify-center bg-[#0e1520] text-white/35">
            <MonitorOff class="size-5" />
        </div>

        <LiveVideoTile
            v-if="screenTrack && cameraTrack"
            :track="cameraTrack"
            label="Kamera"
            fit="cover"
            bare
            class="!absolute right-2 bottom-8 w-[30%] !rounded-md !border-white/25 shadow-md shadow-black/50"
        />

        <div class="absolute top-2 left-2 flex items-center gap-1">
            <span
                v-if="meta"
                class="inline-flex items-center gap-1 rounded-full bg-black/65 px-1.5 py-0.5 text-[10.5px] text-white/90 backdrop-blur-sm font-semibold"
            >
                <span class="led" :class="[meta.led, status === 'alert' && 'motion-safe:animate-pulse']" />
                {{ meta.label }}
            </span>
            <TransportBadge :transport="transport" overlay />
            <span
                v-if="!screenTrack && cameraTrack"
                class="rounded bg-black/65 p-1 text-orange-300 backdrop-blur-sm"
                title="Layar tidak dibagikan"
            >
                <MonitorOff class="size-3" />
            </span>
        </div>

        <div
            class="absolute inset-x-0 bottom-0 flex items-baseline gap-1.5 bg-gradient-to-t from-black/85 to-transparent px-2.5 pt-6 pb-1.5"
        >
            <span class="min-w-0 truncate text-xs font-semibold text-white">{{ name }}</span>
            <span v-if="site" class="min-w-0 truncate text-[10.5px] text-white/60 font-semibold">{{ site }}</span>
            <span v-if="elapsed" class="ml-auto shrink-0 font-mono text-[10px] text-white/75 tabular-nums">{{ elapsed }}</span>
        </div>
    </div>
</template>
