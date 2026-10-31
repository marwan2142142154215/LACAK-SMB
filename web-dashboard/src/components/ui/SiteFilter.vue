<script setup>
import { computed } from 'vue'

import BaseSelect from '@/components/ui/BaseSelect.vue'

/*
 * Penyaring site untuk toolbar daftar: "Semua site" atau satu site.
 * Nilai '' = semua site, selain itu id site (angka).
 */
const props = defineProps({
    sites: { type: Array, default: () => [] },
    modelValue: { type: [Number, String], default: '' },
    label: { type: String, default: 'Filter site' },
    allLabel: { type: String, default: 'Semua site' },
})

defineEmits(['update:modelValue'])

const sortedSites = computed(() => [...props.sites].sort((a, b) => a.name.localeCompare(b.name, 'id')))
</script>

<template>
    <BaseSelect :model-value="modelValue" variant="compact" :aria-label="label" @update:model-value="(value) => $emit('update:modelValue', value)">
        <option value="">{{ allLabel }}</option>
        <option v-for="site in sortedSites" :key="site.id" :value="site.id">{{ site.name }}</option>
    </BaseSelect>
</template>
