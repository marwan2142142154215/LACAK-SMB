<script setup>
import { computed } from 'vue'

// Komposisi status staf dalam satu bar: lebar tiap ruas = jumlah staf dengan
// status itu, bergerak mulus saat status berubah (dorongan gateway). Ruas &
// legenda bisa diklik untuk menyaring dinding video dan daftar status.
const props = defineProps({
    // [{ key, label, bar, count }] -- hanya status yang jumlahnya > 0
    segments: { type: Array, required: true },
    live: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    active: { type: String, default: null },
})

const emit = defineEmits(['select'])

// Yang baik dulu, masalah di ujung kanan -- mata langsung ke ruas merah/oranye.
const ORDER = ['working', 'idle', 'break', 'online', 'screen_off', 'camera_off', 'disconnected', 'alert', 'offline']
const ordered = computed(() =>
    [...props.segments].sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key)),
)
const totalCount = computed(() => props.segments.reduce((sum, segment) => sum + segment.count, 0))

function toggle(key) {
    emit('select', props.active === key ? null : key)
}
</script>

<template>
    <section class="rounded-2xl border border-base-800 bg-base-900 shadow-(--shadow-card)" aria-label="Status staf saat ini">
        <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 pt-4 sm:px-5">
            <div class="flex min-w-0 items-center gap-3">
                <span
                    class="flex size-10 shrink-0 items-center justify-center rounded-xl"
                    :class="live ? 'bg-accent-500/12' : 'bg-base-850'"
                    aria-hidden="true"
                >
                    <span v-if="live" class="beacon" />
                    <span v-else class="size-2 rounded-full bg-base-600" />
                </span>
                <p class="min-w-0 font-display tabular-nums">
                    <span class="text-[2rem] leading-none font-extrabold tracking-[-0.04em] text-base-50">{{ live }}</span>
                    <span class="ml-2 text-sm font-medium text-base-500">dari {{ total }} staf sedang live</span>
                </p>
            </div>
            <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
                <slot name="actions" />
            </div>
        </div>

        <div
            v-if="totalCount"
            class="mx-4 mt-4 flex h-2.5 gap-1 sm:mx-5"
            role="group"
            aria-label="Saring menurut status (lebar = jumlah staf)"
        >
            <button
                v-for="segment in ordered"
                :key="segment.key"
                type="button"
                class="status-segment h-full min-w-3 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                :class="[segment.bar, active && active !== segment.key && 'opacity-25']"
                :style="{ flexGrow: segment.count }"
                :title="`${segment.label}: ${segment.count} staf`"
                :aria-label="`${segment.label}: ${segment.count} staf`"
                :aria-pressed="active === segment.key"
                @click="toggle(segment.key)"
            />
        </div>
        <div v-else class="mx-4 mt-4 h-2.5 rounded-full bg-base-850 sm:mx-5" />

        <!-- Satu baris, bergulir ke samping di layar sempit -- tidak pernah pecah jadi dua baris. -->
        <div
            v-if="totalCount"
            class="legend-row flex gap-1 overflow-x-auto px-3 pt-2.5 pb-3 sm:px-4"
            role="group"
            aria-label="Saring menurut status"
        >
            <button
                v-for="segment in ordered"
                :key="segment.key"
                type="button"
                class="inline-flex shrink-0 items-center gap-2 rounded-full px-2.5 py-1 text-xs whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-accent-500"
                :class="active === segment.key ? 'bg-base-50 text-base-950' : 'text-base-400 hover:bg-base-850 hover:text-base-100'"
                :aria-pressed="active === segment.key"
                @click="toggle(segment.key)"
            >
                <span class="status-dot size-2 rounded-full" :class="segment.bar" />
                {{ segment.label }}
                <span class="font-mono font-medium tabular-nums">{{ segment.count }}</span>
            </button>
        </div>
        <div v-else class="pb-4" />
    </section>
</template>

<style scoped>
.legend-row {
    scrollbar-width: none;
}

.legend-row::-webkit-scrollbar {
    display: none;
}

.status-segment {
    transition:
        flex-grow 600ms cubic-bezier(0.22, 1, 0.36, 1),
        opacity 200ms,
        transform 200ms;
}

.status-segment:hover {
    transform: scaleY(1.6);
}

/* Warna status tema terang digelapkan demi kontras TEKS; untuk bar dibuat lebih cerah. */
:root[data-theme='light'] .status-segment,
:root[data-theme='light'] .status-dot {
    filter: saturate(1.4) brightness(1.2);
}

@media (prefers-reduced-motion: reduce) {
    .status-segment {
        transition: opacity 200ms;
    }

    .status-segment:hover {
        transform: none;
    }
}
</style>
