<script setup>
defineProps({
    icon: { type: [Object, Function], required: true },
    title: { type: String, required: true },
    description: { type: String, default: null },
})
</script>

<!-- Halaman/daftar kosong: jelaskan apa yang akan muncul di sini dan langkah berikutnya -->
<template>
    <div class="flex flex-col items-center px-6 py-14 text-center">
        <div class="relative mb-5 flex size-14 items-center justify-center rounded-full border border-dashed border-base-700">
            <component :is="icon" class="size-6 text-base-400" />
        </div>
        <p class="text-sm font-medium text-base-100">{{ title }}</p>
        <p v-if="description" class="mt-1.5 max-w-sm text-sm text-pretty text-base-500">{{ description }}</p>
        <div v-if="$slots.default" class="mt-5">
            <slot />
        </div>
    </div>
</template>
