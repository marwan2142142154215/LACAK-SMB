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

<!-- Satu angka ringkas: label kecil di atas, nilai besar di bawah -->
<template>
    <div class="min-w-0">
        <p class="eyebrow flex items-center gap-2">
            <span v-if="led" class="led" :class="ledClass[led]" />
            {{ label }}
        </p>
        <p class="mt-1 font-display text-2xl font-semibold tracking-[-0.02em] text-base-50 tabular-nums">{{ value }}</p>
    </div>
</template>
