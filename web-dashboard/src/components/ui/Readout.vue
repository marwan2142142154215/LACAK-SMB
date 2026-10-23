<script setup>
defineProps({
    label: { type: String, required: true },
    value: { type: [String, Number], default: '—' },
    // warna lampu: accent | copper | danger | warning | muted; null = tanpa lampu
    led: { type: String, default: null },
})

const ledClass = {
    accent: 'text-accent-400',
    copper: 'text-copper-400',
    danger: 'text-danger-400',
    warning: 'text-warning-400',
    muted: 'text-base-500 led-off',
}
</script>

<!-- Satu angka instrumen: label mono kecil di atas, nilai besar di bawah -->
<template>
    <div class="min-w-0">
        <p class="eyebrow flex items-center gap-2">
            <span v-if="led" class="led" :class="ledClass[led]" />
            {{ label }}
        </p>
        <p class="mt-1 font-mono text-xl font-medium text-base-50 tabular-nums">{{ value }}</p>
    </div>
</template>
