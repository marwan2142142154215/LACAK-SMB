<script setup>
import { MonitorOff } from '@lucide/vue'
import { computed } from 'vue'

import LiveVideoTile from '@/components/live/LiveVideoTile.vue'
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
})

const now = useNow()
const meta = computed(() => (props.status ? workStatus(props.status) : null))
const mainTrack = computed(() => props.screenTrack ?? props.cameraTrack)
const elapsed = computed(() => (props.since ? formatElapsed(props.since, now.value) : null))
</script>

<template>
    <div class="relative aspect-video overflow-hidden rounded-xl border border-base-800 bg-black shadow-(--shadow-card)">
        <LiveVideoTile
            v-if="mainTrack"
            :track="mainTrack"
            :label="name"
            :fit="screenTrack ? 'contain' : 'cover'"
            bare
            class="!rounded-none !border-0"
        />
        <div v-else class="flex size-full items-center justify-center bg-base-900 text-base-500">
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

        <span
            v-if="meta"
            class="absolute top-2 left-2 inline-flex items-center gap-1 rounded bg-black/65 px-1.5 py-0.5 font-mono text-[9.5px] tracking-[0.08em] text-white/90 uppercase backdrop-blur-sm"
        >
            <span class="led" :class="[meta.led, status === 'alert' && 'motion-safe:animate-pulse']" />
            {{ meta.label }}
        </span>
        <span
            v-if="!screenTrack && cameraTrack"
            class="absolute top-2 right-2 rounded bg-black/65 p-1 text-orange-300 backdrop-blur-sm"
            title="Layar tidak dibagikan"
        >
            <MonitorOff class="size-3" />
        </span>

        <div
            class="absolute inset-x-0 bottom-0 flex items-baseline gap-1.5 bg-gradient-to-t from-black/85 to-transparent px-2.5 pt-6 pb-1.5"
        >
            <span class="min-w-0 truncate text-xs font-semibold text-white">{{ name }}</span>
            <span v-if="site" class="min-w-0 truncate font-mono text-[9.5px] tracking-[0.06em] text-white/60 uppercase">{{ site }}</span>
            <span v-if="elapsed" class="ml-auto shrink-0 font-mono text-[10px] text-white/75 tabular-nums">{{ elapsed }}</span>
        </div>
    </div>
</template>
