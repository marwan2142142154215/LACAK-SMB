<script setup>
import { VideoOff } from '@lucide/vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { formatElapsed, useNow } from '@/composables/useNow'

const props = defineProps({
    track: { type: Object, default: null }, // Track LiveKit (lokal/remote), null = belum ada video
    label: { type: String, required: true },
    mirrored: { type: Boolean, default: false }, // kamera sendiri tampil seperti cermin
    live: { type: Boolean, default: false },
    // cover = penuhi ubin (grid); contain = tampilkan seluruh bingkai kamera tanpa terpotong (tampilan besar)
    fit: { type: String, default: 'cover' },
    since: { type: [Date, String, Number], default: null }, // mulai siaran -> durasi berjalan di pojok
    framed: { type: Boolean, default: false }, // sudut jendela bidik untuk monitor besar
})

const now = useNow()
const videoEl = ref(null)
// Resolusi yang BENAR-BENAR sedang diterima/ditampilkan (bukan yang diminta) --
// layer simulcast bisa turun saat jaringan lemah, dan staf perlu tahu itu.
const frameHeight = ref(0)
let attachedTrack = null

function readFrameSize() {
    frameHeight.value = videoEl.value?.videoHeight ?? 0
}

function detach() {
    if (attachedTrack && videoEl.value) attachedTrack.detach(videoEl.value)
    attachedTrack = null
    frameHeight.value = 0
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

const qualityLabel = computed(() => (frameHeight.value ? `${frameHeight.value}p` : null))
// Teks di atas video sengaja warna tetap (bukan token tema): latar video
// selalu gelap, di tema terang maupun gelap.
const qualityTone = computed(() => {
    if (frameHeight.value >= 700) return 'text-emerald-300'
    if (frameHeight.value >= 340) return 'text-white'
    return 'text-amber-300'
})
const elapsed = computed(() => (props.since ? formatElapsed(props.since, now.value) : null))
</script>

<template>
    <div class="group/tile relative aspect-video overflow-hidden rounded-xl border border-base-800 bg-black">
        <video
            v-show="track"
            ref="videoEl"
            autoplay
            playsinline
            muted
            class="size-full"
            :class="[fit === 'contain' ? 'object-contain' : 'object-cover', mirrored && '-scale-x-100']"
            @loadedmetadata="readFrameSize"
            @resize="readFrameSize"
        />
        <div v-if="!track" class="flex size-full flex-col items-center justify-center gap-2 bg-base-900 text-base-600">
            <VideoOff class="size-6" />
            <span class="font-mono text-[10.5px] tracking-[0.14em] uppercase">Menunggu gambar</span>
        </div>

        <!-- Sudut jendela bidik: penanda "monitor" untuk tampilan besar -->
        <template v-if="framed">
            <span
                v-for="corner in [
                    'top-3 left-3 border-t-2 border-l-2',
                    'top-3 right-3 border-t-2 border-r-2',
                    'bottom-3 left-3 border-b-2 border-l-2',
                    'right-3 bottom-3 border-r-2 border-b-2',
                ]"
                :key="corner"
                aria-hidden="true"
                class="pointer-events-none absolute size-5 border-accent-300/70"
                :class="corner"
            />
        </template>

        <span
            v-if="qualityLabel"
            class="absolute top-2.5 right-2.5 rounded bg-black/65 px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums backdrop-blur-sm"
            :class="[qualityTone, framed && 'top-6 right-10']"
            :title="`Gambar yang sedang ditampilkan: ${qualityLabel}`"
        >
            {{ qualityLabel }}
        </span>

        <div
            class="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-3 pt-8 pb-2.5"
            :class="framed && 'px-6 pb-5'"
        >
            <span
                v-if="live"
                class="inline-flex shrink-0 items-center gap-1 rounded bg-danger-500 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-white"
            >
                <span class="size-1.5 rounded-full bg-white motion-safe:animate-pulse" />
                LIVE
            </span>
            <span class="min-w-0 flex-1 truncate text-xs font-medium text-white" :class="framed && 'text-sm'">{{ label }}</span>
            <span v-if="elapsed" class="shrink-0 font-mono text-[11px] text-white/80 tabular-nums">{{ elapsed }}</span>
        </div>
    </div>
</template>
