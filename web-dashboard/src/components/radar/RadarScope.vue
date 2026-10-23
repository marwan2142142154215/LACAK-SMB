<script setup>
import { computed } from 'vue'

const props = defineProps({
    /** @type {{ id: number, label: string, status: string, distance: number|null }[]} */
    devices: { type: Array, required: true },
    selectedId: { type: Number, default: null },
    maxMeters: { type: Number, default: 200 },
})

const emit = defineEmits(['select'])

const SWEEP_SECONDS = 6
const RING_RADIUS = 86 // viewBox 200x200, sisa ruang untuk tick & mata angin

// Skala akar: jarak dekat (beberapa meter) direnggangkan, jarak jauh dirapatkan --
// supaya device di ruangan yang sama tidak menumpuk jadi satu titik di tengah.
const toRadius = (meters) => Math.sqrt(Math.min(meters, props.maxMeters) / props.maxMeters)

const rings = computed(() => [0.25, 0.5, 0.75, 1].map((r) => ({ r, label: `${Math.round(props.maxMeters * r * r)} m` })))

const ticks = Array.from({ length: 72 }, (_, i) => {
    const angle = i * 5
    const length = angle % 30 === 0 ? 5 : 2
    const rad = (angle * Math.PI) / 180
    return {
        angle,
        x1: Math.sin(rad) * RING_RADIUS,
        y1: -Math.cos(rad) * RING_RADIUS,
        x2: Math.sin(rad) * (RING_RADIUS + length),
        y2: -Math.cos(rad) * (RING_RADIUS + length),
        major: length === 5,
    }
})

const compass = [
    { label: 'U', x: 0, y: -95 },
    { label: 'T', x: 95, y: 0 },
    { label: 'S', x: 0, y: 95 },
    { label: 'B', x: -95, y: 0 },
]

const STATUS_COLOR = {
    online: 'var(--color-accent-400)',
    locked: 'var(--color-danger-400)',
    offline: 'var(--color-base-500)',
    pending_enrollment: 'var(--color-warning-400)',
}

/*
 * Jarak BLE hanya memberi radius, bukan arah -- sudut tiap titik dibagi rata
 * supaya tidak bertumpuk. Device tanpa sinyal BLE ditaruh di cincin terluar
 * dengan garis putus-putus (bukan di tengah, yang akan terbaca "paling dekat").
 */
const blips = computed(() =>
    props.devices.map((device, index) => {
        const angle = (index / Math.max(props.devices.length, 1)) * 360 + 20
        const hasSignal = device.distance != null
        const ratio = hasSignal ? toRadius(device.distance) : 1
        const spread = (RING_RADIUS / 200) * 100 * Math.max(ratio, 0.06)
        const rad = (angle * Math.PI) / 180
        return {
            ...device,
            hasSignal,
            color: STATUS_COLOR[device.status] ?? STATUS_COLOR.offline,
            style: {
                left: `${50 + Math.sin(rad) * spread}%`,
                top: `${50 - Math.cos(rad) * spread}%`,
                // menyala tepat saat garis sapuan lewat di sudut ini
                animationDelay: `${(angle / 360) * SWEEP_SECONDS}s`,
            },
            labelRight: Math.sin(rad) < 0.35,
        }
    }),
)
</script>

<template>
    <div class="scope relative aspect-square w-full select-none" :style="{ '--sweep': `${SWEEP_SECONDS}s` }">
        <svg viewBox="-100 -100 200 200" class="absolute inset-0 size-full overflow-visible" aria-hidden="true">
            <circle cx="0" cy="0" :r="RING_RADIUS" class="fill-base-950/60" />
            <circle
                v-for="ring in rings"
                :key="ring.label"
                :r="ring.r * RING_RADIUS"
                fill="none"
                class="stroke-base-700"
                :stroke-dasharray="ring.r === 1 ? null : '1 2'"
                stroke-width="0.4"
            />
            <line x1="-86" y1="0" x2="86" y2="0" class="stroke-base-800" stroke-width="0.3" />
            <line x1="0" y1="-86" x2="0" y2="86" class="stroke-base-800" stroke-width="0.3" />
            <line
                v-for="tick in ticks"
                :key="tick.angle"
                :x1="tick.x1"
                :y1="tick.y1"
                :x2="tick.x2"
                :y2="tick.y2"
                :class="tick.major ? 'stroke-base-500' : 'stroke-base-700'"
                stroke-width="0.4"
            />
            <text
                v-for="ring in rings"
                :key="`label-${ring.label}`"
                :x="ring.r * RING_RADIUS * 0.7071 + 1.5"
                :y="-ring.r * RING_RADIUS * 0.7071 - 1.5"
                class="fill-base-500 font-mono"
                font-size="3.6"
            >
                {{ ring.label }}
            </text>
            <text
                v-for="point in compass"
                :key="point.label"
                :x="point.x"
                :y="point.y"
                text-anchor="middle"
                dominant-baseline="central"
                class="fill-base-400 font-mono"
                font-size="4.5"
            >
                {{ point.label }}
            </text>
        </svg>

        <div class="sweep pointer-events-none absolute inset-[7%] rounded-full" aria-hidden="true" />

        <!-- Anchor (titik pusat): HP master / device acuan jarak BLE -->
        <span class="absolute top-1/2 left-1/2 size-2.5 -translate-1/2 rounded-full bg-copper-400" aria-hidden="true" />
        <span
            class="anchor-ring absolute top-1/2 left-1/2 size-2.5 -translate-1/2 rounded-full ring-1 ring-copper-400"
            aria-hidden="true"
        />

        <button
            v-for="blip in blips"
            :key="blip.id"
            type="button"
            class="blip-hit group absolute flex size-6 -translate-1/2 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-accent-400"
            :style="{ left: blip.style.left, top: blip.style.top, color: blip.color }"
            :aria-label="`${blip.label}, ${blip.hasSignal ? `${blip.distance} meter` : 'belum ada sinyal BLE'}`"
            :aria-pressed="selectedId === blip.id"
            @click="emit('select', blip.id)"
        >
            <span
                class="blip block size-2 rounded-full"
                :class="[blip.hasSignal ? 'bg-current' : 'border border-dashed border-current', blip.status === 'offline' && 'is-dim']"
                :style="{ animationDelay: blip.style.animationDelay }"
            />
            <span v-if="selectedId === blip.id" class="absolute inset-0 rounded-full ring-1 ring-current" />
            <span
                class="pointer-events-none absolute top-1/2 -translate-y-1/2 rounded bg-base-950/90 px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-base-100 ring-1 ring-base-700 transition-opacity"
                :class="[
                    blip.labelRight ? 'left-full ml-1' : 'right-full mr-1',
                    selectedId === blip.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
                ]"
            >
                {{ blip.label }}
            </span>
        </button>
    </div>
</template>

<style scoped>
.sweep {
    background: conic-gradient(from 0deg, transparent 0deg 290deg, color-mix(in oklab, var(--color-accent-400) 24%, transparent) 360deg);
    animation: sweep var(--sweep) linear infinite;
}

.sweep::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 0;
    width: 1px;
    height: 50%;
    background: linear-gradient(to top, transparent, var(--color-accent-300));
}

.blip {
    box-shadow: 0 0 10px 2px color-mix(in oklab, currentColor 60%, transparent);
    animation: blip var(--sweep) linear infinite;
}

.blip.is-dim {
    box-shadow: none;
}

.anchor-ring {
    animation: ping 2.4s ease-out infinite;
}

@keyframes sweep {
    to {
        transform: rotate(1turn);
    }
}

@keyframes blip {
    0%,
    4% {
        opacity: 1;
        scale: 1.35;
    }
    55%,
    100% {
        opacity: 0.45;
        scale: 1;
    }
}

@keyframes ping {
    to {
        scale: 5;
        opacity: 0;
    }
}

@media (prefers-reduced-motion: reduce) {
    .sweep,
    .blip,
    .anchor-ring {
        animation: none;
    }
}
</style>
