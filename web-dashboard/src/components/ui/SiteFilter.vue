<script setup>
import { computed } from 'vue'

import SearchSelect from '@/components/ui/SearchSelect.vue'

/*
 * Penyaring site untuk toolbar daftar: "Semua site" atau satu site, dengan kolom cari.
 * Nilai '' = semua site, selain itu id site (angka).
 */
const props = defineProps({
    sites: { type: Array, default: () => [] },
    modelValue: { type: [Number, String], default: '' },
    label: { type: String, default: 'Filter site' },
    allLabel: { type: String, default: 'Semua site' },
})

defineEmits(['update:modelValue'])

const options = computed(() => [
    { value: '', label: props.allLabel },
    ...[...props.sites]
        .sort((a, b) => a.name.localeCompare(b.name, 'id'))
        .map((site) => ({ value: site.id, label: site.name })),
])
</script>

<template>
    <SearchSelect
        class="w-56 max-w-full"
        compact
        :aria-label="label"
        search-placeholder="Cari site…"
        empty-text="Tidak ada site"
        :model-value="modelValue"
        :options="options"
        @update:model-value="(value) => $emit('update:modelValue', value)"
    />
</template>
