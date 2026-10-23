<script setup>
defineOptions({ inheritAttrs: false })

defineProps({
    modelValue: { type: [String, Number], default: '' },
    label: { type: String, default: null },
    type: { type: String, default: 'text' },
    placeholder: { type: String, default: '' },
    hint: { type: String, default: null },
    error: { type: String, default: null },
    required: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    autocomplete: { type: String, default: 'off' },
    maxlength: { type: [String, Number], default: null },
    inputmode: { type: String, default: null },
})

defineEmits(['update:modelValue'])
</script>

<template>
    <!-- class/style dari pemanggil ke <label>, atribut lain (step, minlength) ke <input> -->
    <label class="block" :class="$attrs.class" :style="$attrs.style">
        <span v-if="label" class="field-label">
            {{ label }}
            <span v-if="required" class="text-danger-400" aria-hidden="true">*</span>
        </span>
        <input
            v-bind="{ ...$attrs, class: undefined, style: undefined }"
            :value="modelValue"
            :type="type"
            :placeholder="placeholder"
            :disabled="disabled"
            :required="required"
            :autocomplete="autocomplete"
            :maxlength="maxlength"
            :inputmode="inputmode"
            class="field-control"
            :class="error && '!border-danger-500'"
            @input="$emit('update:modelValue', $event.target.value)"
        />
        <span v-if="error" class="mt-1.5 block text-xs text-danger-400">{{ error }}</span>
        <span v-else-if="hint" class="field-hint block">{{ hint }}</span>
    </label>
</template>
