<script setup>
import { ChevronDown } from '@lucide/vue'
import { computed } from 'vue'

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

const toValue = (raw) => (raw === '' ? '' : Number(raw))
</script>

<template>
    <label class="relative">
        <span class="sr-only">{{ label }}</span>
        <select
            :value="modelValue"
            class="field-control h-9 max-w-56 appearance-none pr-8 text-sm"
            @change="$emit('update:modelValue', toValue($event.target.value))"
        >
            <option value="">{{ allLabel }}</option>
            <option v-for="site in sortedSites" :key="site.id" :value="site.id">{{ site.name }}</option>
        </select>
        <ChevronDown class="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-base-500" />
    </label>
</template>
