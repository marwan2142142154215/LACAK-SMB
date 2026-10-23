<script setup>
import { computed } from 'vue'

const props = defineProps({
    // identity -> authenticator -> granted, mengikuti tahap login di LoginView
    phase: { type: String, default: 'identity' },
})

const SWEEP_SECONDS = 6
const RING_RADIUS = 86 // dari viewBox 200x200, sisa ruang untuk tick & mata angin

// Skala jarak BLE sengaja tidak linear -- sama seperti cara radar di APK
// Master membaca RSSI: rapat di dekat, renggang di jauh.
const rings = [
    { r: 0.22, label: '1 m' },
    { r: 0.45, label: '5 m' },
    { r: 0.7, label: '10 m' },
    { r: 1, label: '25 m' },
]

const blips = [
    { angle: 38, r: 0.34 },
    { angle: 74, r: 0.88 },
    { angle: 112, r: 0.62 },
    { angle: 167, r: 0.28 },
    { angle: 221, r: 0.81 },
    { angle: 286, r: 0.52 },
    { angle: 331, r: 0.74 },
]

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

// Tiap titik menyala tepat saat garis sapuan melewati sudutnya.
const blipStyles = computed(() =>
    blips.map(({ angle, r }) => {
        const rad = (angle * Math.PI) / 180
        const spread = (RING_RADIUS / 200) * 100 * r
        return {
            left: `${50 + Math.sin(rad) * spread}%`,
            top: `${50 - Math.cos(rad) * spread}%`,
            animationDelay: `${(angle / 360) * SWEEP_SECONDS}s`,
        }
    }),
)

// Titik pusat = posisi Anda; warnanya ikut tahap login.
const coreColor = computed(
    () =>
        ({
            identity: 'bg-base-300 text-base-300',
            authenticator: 'bg-copper-400 text-copper-400',
            granted: 'bg-accent-300 text-accent-300',
        })[props.phase],
)
</script>

<template>
    <div class="radar relative aspect-square w-full" :style="{ '--sweep': `${SWEEP_SECONDS}s` }" aria-hidden="true">
        <svg viewBox="-100 -100 200 200" class="absolute inset-0 size-full overflow-visible">
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

        <div class="sweep absolute inset-[7%] rounded-full" />

        <span
            v-for="(style, i) in blipStyles"
            :key="i"
            class="blip absolute size-1.5 -translate-1/2 rounded-full bg-copper-400"
            :style="style"
        />

        <span class="absolute top-1/2 left-1/2 size-2.5 -translate-1/2 rounded-full transition-colors duration-700" :class="coreColor" />
        <span
            class="core-ring absolute top-1/2 left-1/2 size-2.5 -translate-1/2 rounded-full bg-transparent! ring-1 ring-current"
            :class="coreColor"
        />
    </div>
</template>

<style scoped>
.sweep {
    background: conic-gradient(from 0deg, transparent 0deg 290deg, color-mix(in oklab, var(--color-accent-400) 28%, transparent) 360deg);
    animation: sweep var(--sweep) linear infinite;
}

/* Tepi depan sapuan: garis tipis dari pusat ke arah utara */
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
    box-shadow: 0 0 10px 2px color-mix(in oklab, var(--color-copper-400) 60%, transparent);
    animation: blip var(--sweep) linear infinite;
    opacity: 0.12;
}

.core-ring {
    animation: core 2.4s ease-out infinite;
}

@keyframes sweep {
    to {
        transform: rotate(1turn);
    }
}

@keyframes blip {
    0%,
    3% {
        opacity: 1;
    }
    60%,
    100% {
        opacity: 0.12;
    }
}

@keyframes core {
    from {
        scale: 1;
        opacity: 0.8;
    }
    to {
        scale: 5;
        opacity: 0;
    }
}

@media (prefers-reduced-motion: reduce) {
    .sweep,
    .blip,
    .core-ring {
        animation: none;
    }

    .blip {
        opacity: 0.8;
    }
}
</style>
