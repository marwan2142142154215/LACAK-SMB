<script setup>
defineProps({
    title: { type: String, default: null },
    subtitle: { type: String, default: null },
})
</script>

<template>
    <section class="rounded-2xl border border-base-800 bg-base-900/60 shadow-xl shadow-black/20">
        <header v-if="title || $slots.actions" class="flex items-center justify-between gap-4 border-b border-base-800 px-5 py-4">
            <div>
                <h2 v-if="title" class="text-sm font-semibold tracking-wide text-base-50">{{ title }}</h2>
                <p v-if="subtitle" class="mt-0.5 text-xs text-base-400">{{ subtitle }}</p>
            </div>
            <div v-if="$slots.actions" class="flex items-center gap-2">
                <slot name="actions" />
            </div>
        </header>
        <div class="p-5">
            <slot />
        </div>
    </section>
</template>
