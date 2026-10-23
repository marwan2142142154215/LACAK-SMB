<script setup>
import { onMounted, ref } from 'vue'

const props = defineProps({
    modelValue: { type: String, default: '' },
    label: { type: String, required: true },
    invalid: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'complete'])

const LENGTH = 6
const inputEl = ref(null)
const focused = ref(false)

/**
 * Satu <input> asli yang transparan menutupi 6 kotak -- jadi tempel (paste),
 * isi otomatis kode SMS/authenticator (one-time-code), dan pembaca layar
 * tetap bekerja seperti input biasa. Kotak-kotaknya hanya tampilan.
 */
function handleInput(event) {
    const digits = event.target.value.replace(/\D/g, '').slice(0, LENGTH)
    event.target.value = digits
    emit('update:modelValue', digits)
    if (digits.length === LENGTH) emit('complete', digits)
}

function focus() {
    inputEl.value?.focus()
}

onMounted(focus)
defineExpose({ focus })
</script>

<template>
    <div class="relative">
        <input
            ref="inputEl"
            :value="props.modelValue"
            :aria-label="label"
            :aria-invalid="invalid"
            :disabled="disabled"
            :maxlength="LENGTH"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            class="absolute inset-0 z-10 size-full cursor-text text-base opacity-0 disabled:cursor-not-allowed"
            @input="handleInput"
            @focus="focused = true"
            @blur="focused = false"
        />
        <!-- 3 + 3 seperti tampilan kode di Google Authenticator: "123 456" -->
        <div class="grid grid-cols-[repeat(3,1fr)_0.75rem_repeat(3,1fr)] gap-2" aria-hidden="true">
            <template v-for="i in LENGTH" :key="i">
                <span v-if="i === 4" class="self-center justify-self-center text-base-600">·</span>
                <span
                    class="relative flex h-14 items-center justify-center rounded-lg border bg-base-850 font-mono text-2xl text-base-50 transition-colors duration-150"
                    :class="[
                        invalid
                            ? 'border-danger-500/70'
                            : focused && i - 1 === modelValue.length
                              ? 'border-accent-400'
                              : modelValue[i - 1]
                                ? 'border-base-600'
                                : 'border-base-800',
                        disabled && 'opacity-50',
                    ]"
                >
                    {{ modelValue[i - 1] ?? '' }}
                    <span v-if="focused && i - 1 === modelValue.length" class="caret absolute h-6 w-px bg-accent-400" />
                </span>
            </template>
        </div>
    </div>
</template>

<style scoped>
.caret {
    animation: caret 1s steps(1) infinite;
}

@keyframes caret {
    50% {
        opacity: 0;
    }
}

@media (prefers-reduced-motion: reduce) {
    .caret {
        animation: none;
    }
}
</style>
