<script setup>
defineProps({
    title: { type: String, required: true },
    subtitle: { type: String, default: null },
    // Kelompok menu tempat halaman ini berada (Pantau / Perangkat / Akses)
    eyebrow: { type: String, default: null },
})
</script>

<template>
    <!-- Band hijau rekening (gaya revenue): judul putih besar di pita gelap, konten di bawahnya -->
    <header class="hero-band px-4 pt-8 pb-7 text-white sm:px-8 sm:pt-10 sm:pb-8">
        <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
            <div class="min-w-0">
                <p v-if="eyebrow" class="mb-2 text-xs font-medium tracking-wide text-white/60">{{ eyebrow }}</p>
                <h1 class="font-display text-[1.75rem] leading-[1.15] font-bold tracking-[-0.02em] text-white sm:text-[2rem]">
                    {{ title }}
                </h1>
                <p v-if="subtitle" class="mt-2 max-w-2xl text-[15px] leading-relaxed text-pretty text-white/75">{{ subtitle }}</p>
            </div>
            <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
                <slot name="actions" />
            </div>
        </div>
        <!-- Readout angka ringkas milik halaman ini (jumlah, status) -->
        <div
            v-if="$slots.readouts"
            class="mt-6 flex flex-wrap gap-x-10 gap-y-4 rounded-xl border border-white/15 bg-white/10 px-5 py-4 backdrop-blur-sm"
        >
            <slot name="readouts" />
        </div>
    </header>
</template>

<style scoped>
.hero-band {
    background-color: #161618;
    background-image:
        radial-gradient(120% 140% at 88% -25%, rgb(245 158 11 / 0.16), transparent 58%),
        linear-gradient(160deg, #0c0c0d, #1c1c20);
}
</style>
