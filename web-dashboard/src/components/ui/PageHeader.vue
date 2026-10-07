<script setup>
defineProps({
    title: { type: String, required: true },
    subtitle: { type: String, default: null },
})
</script>

<template>
    <header class="border-b border-base-800 bg-base-900/40 px-8 py-6">
        <div class="flex items-center justify-between gap-4">
            <div>
                <h1 class="text-lg font-bold text-base-50">{{ title }}</h1>
                <p v-if="subtitle" class="mt-1 text-sm text-base-400">{{ subtitle }}</p>
            </div>
            <div v-if="$slots.actions" class="flex items-center gap-3">
                <slot name="actions" />
            </div>
        </div>
    </header>
</template>
