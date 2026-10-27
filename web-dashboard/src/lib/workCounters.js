import { ref } from 'vue'

/**
 * Naik setiap kali pengumuman dibaca/dihapus atau pengajuan izin diproses --
 * angka di menu & banner pengumuman di AppShell memuat ulang.
 */
export const workCountersVersion = ref(0)
export const refreshWorkCounters = () => workCountersVersion.value++
