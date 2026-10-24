<script setup>
defineProps({
    title: { type: String, default: null },
    subtitle: { type: String, default: null },
    // Jumlah item di dalam kartu, tampil di samping judul
    count: { type: Number, default: null },
    // true = isi menempel ke tepi (tabel, daftar bergaris), tanpa padding
    flush: { type: Boolean, default: false },
})
</script>

<template>
    <section class="overflow-hidden rounded-xl border border-base-800 bg-base-900 shadow-(--shadow-card)">
        <header
            v-if="title || $slots.actions"
            class="flex flex-wrap items-center justify-between gap-3 border-b border-base-800 px-5 py-3.5"
        >
            <div class="min-w-0">
                <h2 v-if="title" class="eyebrow flex items-center gap-2 !text-base-200">
                    {{ title }}
                    <span v-if="count != null" class="text-base-500">{{ count }}</span>
                </h2>
                <p v-if="subtitle" class="mt-1 text-xs text-base-500">{{ subtitle }}</p>
            </div>
            <div v-if="$slots.actions" class="flex items-center gap-2">
                <slot name="actions" />
            </div>
        </header>
        <div :class="flush ? '' : 'p-5'">
            <slot />
        </div>
    </section>
</template>
