<script setup>
import { Loader2 } from '@lucide/vue'
import { computed } from 'vue'

const props = defineProps({
    variant: { type: String, default: 'primary' }, // primary | outline | ghost | danger | danger-outline
    size: { type: String, default: 'md' }, // sm | md | icon
    loading: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    type: { type: String, default: 'button' },
})

const variantClasses = computed(
    () =>
        ({
            // Tombol utama = biru aksen, satu-satunya isian berwarna di halaman
            primary: 'bg-accent-500 text-white shadow-sm hover:bg-accent-600',
            outline: 'border border-base-700 bg-base-900 text-base-100 shadow-(--shadow-card) hover:border-base-600 hover:bg-base-850',
            ghost: 'text-base-300 hover:bg-base-850 hover:text-base-50',
            danger: 'bg-danger-500 text-white hover:bg-danger-600',
            // Tindakan merusak yang muncul di banyak baris: tenang sampai disorot
            'danger-outline': 'border border-base-700 text-danger-400 hover:border-danger-500/50 hover:bg-danger-500/10',
        })[props.variant],
)

const sizeClasses = computed(
    () =>
        ({
            sm: 'h-8 px-3 text-xs',
            md: 'h-10 px-4.5 text-sm',
            icon: 'size-9',
        })[props.size],
)
</script>

<template>
    <button
        :type="type"
        :disabled="disabled || loading"
        class="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-[background-color,border-color,color,transform] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
        :class="[variantClasses, sizeClasses]"
    >
        <Loader2 v-if="loading" class="size-4 animate-spin" />
        <slot />
    </button>
</template>
