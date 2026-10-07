<script setup>
import { Loader2 } from '@lucide/vue'
import { computed } from 'vue'

const props = defineProps({
    variant: { type: String, default: 'primary' }, // primary | ghost | danger | outline
    size: { type: String, default: 'md' }, // sm | md
    loading: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    type: { type: String, default: 'button' },
})

const variantClasses = computed(
    () =>
        ({
            primary: 'bg-accent-500 text-base-950 hover:bg-accent-400 focus-visible:outline-accent-400 shadow-lg shadow-accent-500/20',
            outline: 'border border-base-600 text-base-100 hover:border-accent-500/60 hover:text-accent-300',
            ghost: 'text-base-300 hover:bg-base-800 hover:text-base-50',
            danger: 'bg-danger-500 text-base-50 hover:bg-danger-400 focus-visible:outline-danger-400',
        })[props.variant],
)

const sizeClasses = computed(
    () =>
        ({
            sm: 'h-8 px-3 text-xs',
            md: 'h-10 px-4 text-sm',
        })[props.size],
)
</script>

<template>
    <button
        :type="type"
        :disabled="disabled || loading"
        class="inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        :class="[variantClasses, sizeClasses]"
    >
        <Loader2 v-if="loading" class="size-4 animate-spin" />
        <slot />
    </button>
</template>
