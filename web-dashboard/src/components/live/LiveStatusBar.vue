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
    <section class="rounded-2xl border border-base-800 bg-base-900 p-4 shadow-(--shadow-card) sm:p-5" aria-label="Status staf saat ini">
        <div class="flex flex-wrap items-end justify-between gap-4">
            <div class="min-w-0">
                <p class="eyebrow flex items-center gap-2">
                    <span v-if="live" class="beacon" />
                    Sedang live
                </p>
                <p class="mt-1 flex items-baseline gap-2 font-display tabular-nums">
                    <span class="text-5xl leading-none font-extrabold tracking-[-0.045em] text-base-50">{{ live }}</span>
                    <span class="text-base font-semibold text-base-500">dari {{ total }} staf</span>
                </p>
            </div>
            <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
                <slot name="actions" />
            </div>
        </div>

        <div
            v-if="totalCount"
            class="mt-5 flex h-3 w-full gap-1"
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
        <div v-else class="mt-5 h-3 w-full rounded-full bg-base-850" />

        <div v-if="totalCount" class="mt-3 flex flex-wrap gap-1.5">
            <button
                v-for="segment in ordered"
                :key="segment.key"
                type="button"
                class="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-accent-500"
                :class="active === segment.key ? 'bg-base-50 text-base-950' : 'text-base-400 hover:bg-base-850 hover:text-base-100'"
                :aria-pressed="active === segment.key"
                @click="toggle(segment.key)"
            >
                <span class="status-dot size-2 rounded-full" :class="segment.bar" />
                {{ segment.label }}
                <span class="font-mono font-medium tabular-nums">{{ segment.count }}</span>
            </button>
        </div>
    </section>
</template>

<style scoped>
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
