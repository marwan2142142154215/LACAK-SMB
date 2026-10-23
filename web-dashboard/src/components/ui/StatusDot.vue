<script setup>
import { computed } from 'vue'

const props = defineProps({
    // Status device (online/offline/locked/pending_enrollment) atau status
    // umum lain yang dipetakan di STATUS di bawah.
    status: { type: String, required: true },
    label: { type: String, default: null },
})

const STATUS = {
    online: { text: 'Online', color: 'text-accent-400' },
    offline: { text: 'Offline', color: 'text-base-500', off: true },
    locked: { text: 'Terkunci', color: 'text-danger-400' },
    pending_enrollment: { text: 'Menunggu daftar', color: 'text-warning-400' },
    active: { text: 'Aktif', color: 'text-accent-400' },
    inactive: { text: 'Nonaktif', color: 'text-base-500', off: true },
    success: { text: 'Berhasil', color: 'text-accent-400' },
    building: { text: 'Sedang build', color: 'text-warning-400' },
    pending: { text: 'Antre', color: 'text-warning-400' },
    failed: { text: 'Gagal', color: 'text-danger-400' },
}

const meta = computed(() => STATUS[props.status] ?? { text: props.status, color: 'text-base-400', off: true })
</script>

<!-- Lampu status ala panel instrumen + teksnya; warna tidak pernah jadi satu-satunya penanda -->
<template>
    <span class="inline-flex items-center gap-2 text-xs font-medium whitespace-nowrap" :class="meta.color">
        <span class="led" :class="meta.off && 'led-off'" />
        <span class="text-base-200">{{ label ?? meta.text }}</span>
    </span>
</template>
