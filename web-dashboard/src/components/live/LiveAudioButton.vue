<script setup>
import { MicOff, Volume2, VolumeX } from '@lucide/vue'
import { computed } from 'vue'

// Tombol suara satu staf untuk penonton. Suara tiap staf default tidak
// diputar; klik = dengarkan, klik lagi = bisukan. Kalau staf sendiri
// membisukan mikrofonnya (atau siaran dari perangkat tanpa mikrofon),
// tombol hanya menunjukkan itu. Selalu di atas video -> warna tetap putih.
const props = defineProps({
    name: { type: String, required: true },
    // on | muted | none -- lihat micStateOf() di stores/live
    micState: { type: String, default: 'none' },
    listening: { type: Boolean, default: false },
    speaking: { type: Boolean, default: false },
})

defineEmits(['toggle'])

const available = computed(() => props.micState === 'on')
const label = computed(() => {
    if (props.micState === 'muted') return `${props.name} membisukan mikrofonnya`
    if (props.micState === 'none') return `${props.name} tidak menyiarkan suara`
    return props.listening ? `Bisukan suara ${props.name}` : `Dengarkan suara ${props.name}`
})
</script>

<template>
    <button
        type="button"
        class="relative flex size-8 items-center justify-center rounded-full backdrop-blur-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400 disabled:cursor-not-allowed"
        :class="
            listening && available
                ? 'bg-emerald-500 text-white shadow-md shadow-emerald-900/40 hover:bg-emerald-400'
                : 'bg-black/60 text-white/85 hover:bg-black/80 hover:text-white disabled:text-white/45 disabled:hover:bg-black/60'
        "
        :disabled="!available"
        :aria-pressed="available ? listening : undefined"
        :aria-label="label"
        :title="label"
        @click.stop="$emit('toggle')"
    >
        <MicOff v-if="!available" class="size-4" />
        <Volume2 v-else-if="listening" class="size-4" />
        <VolumeX v-else class="size-4" />
        <!-- Sedang bicara: cincin berdenyut, terlihat walau suaranya tidak diputar -->
        <span
            v-if="speaking && available"
            class="pointer-events-none absolute -inset-0.5 rounded-full ring-2 ring-emerald-400 motion-safe:animate-pulse"
            aria-hidden="true"
        />
    </button>
</template>
