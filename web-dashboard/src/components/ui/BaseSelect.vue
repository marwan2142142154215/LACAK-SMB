<script setup>
import { Check, ChevronDown } from '@lucide/vue'
import {
    SelectContent,
    SelectItem,
    SelectItemText,
    SelectPortal,
    SelectRoot,
    SelectTrigger,
    SelectViewport,
} from 'reka-ui'
import { Comment, Fragment, computed, useId, useSlots } from 'vue'

/*
 * Dropdown bertema (menggantikan <select> bawaan browser, yang tampilannya tidak bisa diatur).
 * Cara pakai SAMA dengan <select>: isi dengan <option :value="...">Label</option> (boleh v-for,
 * boleh :disabled), dan v-model menyimpan value aslinya (angka / null / teks -- bukan string).
 *
 * variant: 'field' (kolom form, ada label & hint), 'compact' (filter di toolbar, tinggi 36px),
 * 'ghost' (teks kecil tanpa kotak, mis. pemilih ruang chat).
 */
const props = defineProps({
    modelValue: { type: [String, Number, Boolean, null], default: null },
    label: { type: String, default: null },
    /** Label untuk pembaca layar kalau tidak ada label yang terlihat (mis. filter toolbar). */
    ariaLabel: { type: String, default: null },
    hint: { type: String, default: null },
    placeholder: { type: String, default: '' },
    required: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    variant: { type: String, default: 'field' }, // field | compact | ghost
})

const emit = defineEmits(['update:modelValue'])

const slots = useSlots()
const labelId = useId()

const textOf = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    if (node.type === Comment) return ''
    return typeof node.children === 'string' ? node.children : textOf(node.children)
}

function collect(nodes, out) {
    for (const node of nodes ?? []) {
        if (Array.isArray(node)) collect(node, out)
        else if (node?.type === Fragment) collect(node.children, out)
        else if (node?.type === 'optgroup') collect(node.children, out)
        else if (node?.type === 'option') {
            const attrs = node.props ?? {}
            const text = textOf(node.children).replace(/\s+/g, ' ').trim()
            out.push({
                value: 'value' in attrs ? attrs.value : text,
                label: text,
                disabled: attrs.disabled !== undefined && attrs.disabled !== false,
            })
        }
    }
    return out
}

/** Dibaca TIAP render (di template), supaya perubahan isi <option> dari induk ikut tampil. */
const readOptions = () => collect(slots.default?.(), [])

const sameValue = (a, b) => a === b || (a !== null && b !== null && String(a) === String(b))

// Nilai item Reka tidak boleh kosong; pakai nomor urut, lalu petakan balik ke value asli.
const keyOf = (options) => {
    const index = options.findIndex((option) => sameValue(option.value, props.modelValue))
    return index === -1 ? undefined : String(index)
}
const selectedOf = (options) => options[Number(keyOf(options))] ?? null
const pick = (options, key) => {
    const option = options[Number(key)]
    if (option && !option.disabled) emit('update:modelValue', option.value)
}
// Kosong = belum ada pilihan yang bermakna (null / '' / opsi nonaktif "Pilih ...").
const isEmpty = (options) => {
    const selected = selectedOf(options)
    return !selected || selected.disabled || selected.value === null || selected.value === ''
}

const triggerClasses = computed(
    () =>
        ({
            field: 'field-control flex w-full items-center justify-between gap-2 text-left',
            compact:
                'field-control flex h-9 w-auto max-w-56 min-w-32 items-center justify-between gap-2 py-0 text-left text-sm',
            ghost:
                'flex max-w-full items-center gap-1 rounded-md py-0.5 text-xs font-medium text-base-300 hover:text-base-50 focus-visible:outline-2 focus-visible:outline-accent-400',
        })[props.variant] ?? '',
)
</script>

<template>
    <div :class="variant === 'field' ? 'block' : 'inline-block'">
        <template v-for="(options, pass) in [readOptions()]" :key="pass">
            <span v-if="label" :id="labelId" class="field-label">
                {{ label }}
                <span v-if="required" class="text-danger-400" aria-hidden="true">*</span>
            </span>
            <SelectRoot
                :model-value="keyOf(options)"
                :disabled="disabled"
                @update:model-value="(key) => pick(options, key)"
            >
                <span class="relative block">
                    <SelectTrigger
                        :aria-labelledby="label ? labelId : undefined"
                        :aria-label="label ? undefined : ariaLabel"
                        :aria-required="required || undefined"
                        :class="[triggerClasses, disabled && 'cursor-not-allowed opacity-60']"
                    >
                        <span class="truncate" :class="isEmpty(options) && 'text-base-500'">
                            {{ selectedOf(options)?.label || placeholder || ' ' }}
                        </span>
                        <ChevronDown class="pointer-events-none size-4 shrink-0 text-base-500" />
                    </SelectTrigger>
                    <!-- Pengisi untuk validasi "wajib diisi" bawaan form: tampil sebagai gelembung di atas dropdown. -->
                    <input
                        v-if="required"
                        class="pointer-events-none absolute inset-0 h-full w-full opacity-0"
                        tabindex="-1"
                        aria-hidden="true"
                        required
                        :value="isEmpty(options) ? '' : '1'"
                        @focus="$event.target.previousElementSibling?.focus()"
                    />
                </span>
                <SelectPortal>
                    <SelectContent
                        position="popper"
                        :side-offset="6"
                        :collision-padding="12"
                        class="menu-content z-[60] max-h-72 min-w-[max(var(--reka-select-trigger-width),10rem)] overflow-hidden rounded-lg border border-base-700 bg-base-850 shadow-xl shadow-black/50"
                    >
                        <SelectViewport class="max-h-72 overflow-y-auto p-1">
                            <SelectItem
                                v-for="(option, index) in options"
                                :key="index"
                                :value="String(index)"
                                :disabled="option.disabled"
                                class="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm text-base-100 outline-none select-none data-[disabled]:cursor-default data-[disabled]:text-base-500 data-[highlighted]:bg-base-800 data-[state=checked]:text-accent-400"
                            >
                                <SelectItemText>{{ option.label }}</SelectItemText>
                                <Check v-if="sameValue(option.value, modelValue) && !option.disabled" class="size-4 shrink-0" />
                            </SelectItem>
                        </SelectViewport>
                    </SelectContent>
                </SelectPortal>
            </SelectRoot>
            <span v-if="hint" class="field-hint block">{{ hint }}</span>
        </template>
    </div>
</template>
