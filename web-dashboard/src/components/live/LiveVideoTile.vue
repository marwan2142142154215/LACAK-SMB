<script setup>
import { VideoOff } from '@lucide/vue'
import { onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
    track: { type: Object, default: null }, // Track LiveKit (lokal/remote), null = belum ada video
    label: { type: String, required: true },
    mirrored: { type: Boolean, default: false }, // kamera sendiri tampil seperti cermin
    live: { type: Boolean, default: false },
})

const videoEl = ref(null)
let attachedTrack = null

function detach() {
    if (attachedTrack && videoEl.value) attachedTrack.detach(videoEl.value)
    attachedTrack = null
}

// attach() mendaftarkan <video> ini ke track -- dengan adaptiveStream aktif,
// LiveKit mengukur elemen inilah untuk memilih resolusi yang dikirim.
watch(
    [() => props.track, videoEl],
    ([track, el]) => {
        detach()
        if (track && el) {
            track.attach(el)
            attachedTrack = track
        }
    },
    { immediate: true },
)

onBeforeUnmount(detach)
</script>

<template>
    <div class="relative aspect-video overflow-hidden rounded-xl border border-base-800 bg-base-900">
        <video v-show="track" ref="videoEl" autoplay playsinline muted class="size-full object-cover" :class="mirrored && '-scale-x-100'" />
        <div v-if="!track" class="flex size-full items-center justify-center text-base-600">
            <VideoOff class="size-6" />
        </div>
        <div class="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-3 pt-6 pb-2">
            <span
                v-if="live"
                class="inline-flex items-center gap-1 rounded bg-danger-500 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-white"
            >
                <span class="size-1.5 animate-pulse rounded-full bg-white" />
                LIVE
            </span>
            <span class="truncate text-xs font-medium text-base-50">{{ label }}</span>
        </div>
    </div>
</template>
