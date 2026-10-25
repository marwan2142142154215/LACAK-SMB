<script setup>
import { computed } from 'vue'

// Jalur video staf: UDP (normal) atau TCP (UDP diblokir, biasanya VPN/firewall
// -- berat untuk server & gambar mudah patah-patah). Dilaporkan browser staf
// lewat gateway; null = belum diketahui (tidak ditampilkan).
const props = defineProps({
    transport: { type: String, default: null },
    // Ditumpuk di atas video (ubin kecil): latar gelap, bukan chip berbingkai.
    overlay: { type: Boolean, default: false },
})

const TRANSPORTS = {
    udp: {
        label: 'UDP',
        title: 'Video lewat UDP (normal)',
        chip: 'border-st-online/30 bg-st-online/10 text-st-online',
        text: 'text-st-online',
    },
    tcp: {
        label: 'TCP',
        title: 'Video lewat TCP: UDP diblokir (biasanya VPN/firewall). Berat untuk server & gambar bisa patah-patah.',
        chip: 'border-warning-500/40 bg-warning-500/15 text-warning-400',
        text: 'text-warning-400',
    },
}

const meta = computed(() => TRANSPORTS[props.transport] ?? null)
</script>

<template>
    <span
        v-if="meta"
        class="inline-flex shrink-0 items-center rounded font-mono tracking-[0.08em] uppercase"
        :class="overlay ? ['bg-black/65 px-1.5 py-0.5 text-[9.5px] backdrop-blur-sm', meta.text] : ['border px-1.5 py-0.5 text-[10px]', meta.chip]"
        :title="meta.title"
    >
        {{ meta.label }}
    </span>
</template>
