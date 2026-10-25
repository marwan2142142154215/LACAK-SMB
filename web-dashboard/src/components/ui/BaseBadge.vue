<script setup>
import { computed } from 'vue'

const props = defineProps({
    variant: { type: String, default: 'neutral' }, // neutral | success | warning | danger | accent
})

const classes = computed(
    () =>
        ({
            neutral: 'bg-base-800/80 text-base-300 ring-base-700',
            success: 'bg-st-working/10 text-st-working ring-st-working/25',
            warning: 'bg-warning-500/10 text-warning-400 ring-warning-500/25',
            danger: 'bg-danger-500/10 text-danger-400 ring-danger-500/25',
            accent: 'bg-copper-500/10 text-copper-400 ring-copper-500/25',
        })[props.variant],
)
</script>

<template>
    <span
        class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ring-1 ring-inset"
        :class="classes"
    >
        <slot />
    </span>
</template>
