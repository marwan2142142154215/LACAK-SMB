<script setup>
import { Ban, Check, ImagePlus, Sparkles } from '@lucide/vue'
import { ref } from 'vue'

import BaseDialog from '@/components/ui/BaseDialog.vue'

/**
 * Pilihan background kamera untuk briefing: kamera asli, blur, gambar bawaan,
 * atau gambar unggahan sendiri (diperkecil ke 1280px lalu disimpan di browser).
 */
const props = defineProps({
    open: { type: Boolean, default: false },
    value: { type: Object, required: true },
    applying: { type: Boolean, default: false },
})
const emit = defineEmits(['update:open', 'select'])

const MAX_SIDE = 1280

// Gambar bawaan dibuat di browser (gradasi), tanpa berkas tambahan.
function gradient(stops) {
    const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 })
    const context = canvas.getContext('2d')
    const fill = context.createLinearGradient(0, 0, 1280, 720)
    stops.forEach((color, index) => fill.addColorStop(index / (stops.length - 1), color))
    context.fillStyle = fill
    context.fillRect(0, 0, 1280, 720)
    return canvas.toDataURL('image/jpeg', 0.9)
}

const PRESETS = [
    { name: 'Biru kantor', stops: ['#0f2a4a', '#1f5f8b', '#9cc3dd'] },
    { name: 'Abu netral', stops: ['#2b2f36', '#5b626d', '#c9cdd3'] },
    { name: 'Hangat', stops: ['#4a2412', '#b8643a', '#f1cfa8'] },
    { name: 'Hijau tenang', stops: ['#10332b', '#2f7a63', '#bfe0d2'] },
].map((preset) => ({ ...preset, image: gradient(preset.stops) }))

const uploadError = ref('')

function isSelected(option) {
    if (option.mode !== 'image') return props.value.mode === option.mode
    return props.value.mode === 'image' && props.value.image === option.image
}

function choose(option) {
    emit('select', { mode: option.mode, image: option.image ?? null })
}

async function upload(event) {
    const file = event.target.files[0]
    event.target.value = ''
    uploadError.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
        uploadError.value = 'Pilih berkas gambar (JPG, PNG, atau WebP).'
        return
    }
    try {
        const bitmap = await createImageBitmap(file)
        const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
        const canvas = Object.assign(document.createElement('canvas'), {
            width: Math.round(bitmap.width * scale),
            height: Math.round(bitmap.height * scale),
        })
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        bitmap.close()
        choose({ mode: 'image', image: canvas.toDataURL('image/jpeg', 0.85) })
    } catch {
        uploadError.value = 'Gambar tidak bisa dibaca. Coba gambar lain.'
    }
}
</script>

<template>
    <BaseDialog
        :open="open"
        title="Background kamera"
        description="Hanya untuk briefing. Diproses di komputer Anda; peserta lain melihat hasilnya. Live Kerja tetap memakai kamera asli."
        @update:open="(v) => emit('update:open', v)"
    >
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Background kamera">
            <button
                v-for="option in [
                    { mode: 'none', name: 'Kamera asli', icon: Ban },
                    { mode: 'blur', name: 'Blur', icon: Sparkles },
                ]"
                :key="option.mode"
                type="button"
                role="radio"
                :aria-checked="isSelected(option)"
                :disabled="applying"
                class="relative flex aspect-video flex-col items-center justify-center gap-1.5 rounded-xl border bg-base-850 text-sm font-semibold text-base-200 transition-colors hover:border-base-500 disabled:opacity-60"
                :class="isSelected(option) ? 'border-accent-500 ring-2 ring-accent-500/40' : 'border-base-700'"
                @click="choose(option)"
            >
                <component :is="option.icon" class="size-5" :class="option.mode === 'blur' && 'text-accent-400'" />
                {{ option.name }}
            </button>
            <button
                v-for="preset in PRESETS"
                :key="preset.name"
                type="button"
                role="radio"
                :aria-checked="isSelected({ mode: 'image', image: preset.image })"
                :disabled="applying"
                class="relative aspect-video overflow-hidden rounded-xl border bg-cover bg-center transition-colors disabled:opacity-60"
                :class="
                    isSelected({ mode: 'image', image: preset.image }) ? 'border-accent-500 ring-2 ring-accent-500/40' : 'border-base-700'
                "
                :style="{ backgroundImage: `url(${preset.image})` }"
                @click="choose({ mode: 'image', image: preset.image })"
            >
                <span class="absolute inset-x-0 bottom-0 bg-black/45 px-2 py-1 text-left text-xs font-semibold text-white">{{
                    preset.name
                }}</span>
            </button>
            <button
                v-if="value.mode === 'image' && !PRESETS.some((preset) => preset.image === value.image)"
                type="button"
                role="radio"
                aria-checked="true"
                class="relative aspect-video overflow-hidden rounded-xl border border-accent-500 bg-cover bg-center ring-2 ring-accent-500/40"
                :style="{ backgroundImage: `url(${value.image})` }"
            >
                <span class="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-black/45 px-2 py-1 text-xs font-semibold text-white">
                    <Check class="size-3.5" /> Gambar Anda
                </span>
            </button>
            <label
                class="flex aspect-video cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-base-600 text-sm font-semibold text-base-300 transition-colors hover:border-base-400 hover:text-base-100"
            >
                <ImagePlus class="size-5" />
                Unggah gambar
                <input type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" :disabled="applying" @change="upload" />
            </label>
        </div>
        <p v-if="uploadError" class="mt-3 text-sm text-danger-400" role="alert">{{ uploadError }}</p>
        <p v-else class="mt-3 text-xs text-pretty text-base-500">
            Pilihan diingat di browser ini. Di komputer yang lambat, blur atau gambar bisa membuat video sedikit tersendat.
        </p>
    </BaseDialog>
</template>
