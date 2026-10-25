<script setup>
import { Laptop, Smartphone } from '@lucide/vue'
import { computed } from 'vue'

// Ikon perangkat tempat staf sedang login (roster /live/overview:
// login_device). Tidak tampil kalau staf tidak sedang login.
const props = defineProps({
    device: { type: String, default: null },
})

const meta = computed(
    () =>
        ({
            computer: { icon: Laptop, label: 'Login dari laptop/PC' },
            phone: { icon: Smartphone, label: 'Login dari HP' },
        })[props.device] ?? null,
)
</script>

<template>
    <span v-if="meta" class="inline-flex shrink-0 text-base-500" :title="meta.label">
        <component :is="meta.icon" class="size-3.5" aria-hidden="true" />
        <span class="sr-only">{{ meta.label }}</span>
    </span>
</template>
