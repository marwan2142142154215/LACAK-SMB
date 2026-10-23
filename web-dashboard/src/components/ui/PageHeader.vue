<script setup>
defineProps({
    title: { type: String, required: true },
    subtitle: { type: String, default: null },
    // Kelompok menu tempat halaman ini berada (Pantau / Perangkat / Akses)
    eyebrow: { type: String, default: null },
})
</script>

<template>
    <header class="border-b border-base-800 px-4 pt-6 pb-5 sm:px-8 sm:pt-8">
        <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
            <div class="min-w-0">
                <p v-if="eyebrow" class="eyebrow mb-2">{{ eyebrow }}</p>
                <h1 class="font-display text-2xl leading-tight font-semibold tracking-[-0.015em] text-base-50 sm:text-[1.75rem]">
                    {{ title }}
                </h1>
                <p v-if="subtitle" class="mt-1.5 max-w-2xl text-sm text-pretty text-base-400">{{ subtitle }}</p>
            </div>
            <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
                <slot name="actions" />
            </div>
        </div>
        <!-- Readout angka ringkas milik halaman ini (jumlah, status) -->
        <div v-if="$slots.readouts" class="mt-6 flex flex-wrap gap-x-8 gap-y-3">
            <slot name="readouts" />
        </div>
    </header>
</template>
