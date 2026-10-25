<script setup>
defineProps({
    title: { type: String, required: true },
    subtitle: { type: String, default: null },
    // Kelompok menu tempat halaman ini berada (Pantau / Perangkat / Akses)
    eyebrow: { type: String, default: null },
})
</script>

<template>
    <header class="px-4 pt-7 pb-2 sm:px-8 sm:pt-9">
        <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
            <div class="min-w-0">
                <p v-if="eyebrow" class="eyebrow mb-2">{{ eyebrow }}</p>
                <h1 class="font-display text-[1.75rem] leading-[1.1] font-extrabold tracking-[-0.035em] text-base-50 sm:text-[2.25rem]">
                    {{ title }}
                </h1>
                <p v-if="subtitle" class="mt-2 max-w-2xl text-[15px] leading-relaxed text-pretty text-base-400">{{ subtitle }}</p>
            </div>
            <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
                <slot name="actions" />
            </div>
        </div>
        <!-- Readout angka ringkas milik halaman ini (jumlah, status) -->
        <div
            v-if="$slots.readouts"
            class="mt-6 flex flex-wrap gap-x-10 gap-y-4 rounded-2xl border border-base-800 bg-base-900 px-5 py-4 shadow-(--shadow-card)"
        >
            <slot name="readouts" />
        </div>
    </header>
</template>
