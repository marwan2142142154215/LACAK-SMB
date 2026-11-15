<script setup>
import { QrCode, ShieldCheck, Smartphone } from '@lucide/vue'
import dayjs from 'dayjs'
import { computed, ref, watch } from 'vue'

import BaseButton from '@/components/ui/BaseButton.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'

/**
 * Panduan pemasangan APK SMB Pelacak untuk satu build:
 *  1. Pasang biasa (HP yang sudah dipakai): unduh, pasang, buka, ikuti "Mulai penyiapan".
 *  2. HP aset kantor baru (Device Owner): reset pabrik, pindai QR provisioning -- izin diatur
 *     otomatis, kunci jarak jauh paling kuat. QR dibuat server (GET /apk-builds/:id/provisioning).
 */
const props = defineProps({
    build: { type: Object, default: null },
})
const emit = defineEmits(['close'])
const toast = useToast()

const mode = ref('sideload')
const provisioning = ref(null)
const loadingQr = ref(false)

// Gambar QR dari SVG buatan server (pustaka qrcode di backend), ditampilkan sebagai <img> --
// bukan v-html, jadi isi SVG tidak pernah dieksekusi sebagai markup halaman.
const qrSrc = computed(() =>
    provisioning.value?.qr_svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(provisioning.value.qr_svg)}` : null,
)

watch(
    () => props.build?.id,
    () => {
        mode.value = 'sideload'
        provisioning.value = null
    },
)

async function loadQr() {
    loadingQr.value = true
    try {
        const response = await api.get(`/apk-builds/${props.build.id}/provisioning`)
        provisioning.value = response.data.data
    } catch (err) {
        toast.error('Gagal membuat QR', err.response?.data?.message)
    } finally {
        loadingQr.value = false
    }
}

const SIDELOAD_STEPS = [
    'Unduh APK ini langsung di HP tujuan (atau kirim berkasnya lewat kabel/Bluetooth — jangan lewat grup chat).',
    'Buka berkasnya lalu izinkan "Instal aplikasi tak dikenal" untuk browser/pengelola berkas bila diminta, kemudian Instal.',
    'Buka aplikasi SMB Pelacak dan tekan "Mulai penyiapan". Aplikasi meminta izin satu per satu dengan penjelasannya — pilih Izinkan di setiap langkah.',
    'Untuk HP Xiaomi/Oppo/Vivo/Realme/Infinix: ikuti kartu "Khusus HP …" (aktifkan Mulai otomatis & baterai tanpa batasan).',
    'Selesai bila layar menampilkan "Terhubung ke server" dan device muncul Online di menu Device. Notifikasi "Lacak SMB sedang memantau" tetap tampil — itu disengaja.',
]

const OWNER_STEPS = [
    'Khusus HP milik kantor yang BARU atau sudah di-reset pabrik (semua data di HP terhapus saat reset).',
    'Di layar sambutan pertama ("Halo"/"Welcome"), ketuk layar 6 kali di tempat yang sama sampai pemindai QR terbuka.',
    'Sambungkan ke WiFi bila diminta, lalu pindai QR di bawah. Android mengunduh & memasang SMB Pelacak sebagai pengelola HP.',
    'Setujui layar persetujuan Android sampai selesai. Izin lokasi, notifikasi, dan kunci jarak jauh diatur otomatis.',
    'Buka SMB Pelacak sekali untuk memastikan semua langkah ✓ (biasanya hanya "Tanpa batasan baterai" yang perlu disetujui).',
]
</script>

<template>
    <BaseDialog
        :open="!!build"
        title="Panduan pasang SMB Pelacak"
        :description="build ? `Versi ${build.version} · ${build.organization_name ?? build.embedded_site_code}` : ''"
        size="lg"
        @update:open="(v) => !v && emit('close')"
    >
        <div v-if="build" class="space-y-4">
            <div class="flex gap-1 rounded-lg bg-base-850 p-1" role="tablist" aria-label="Cara pasang">
                <button
                    type="button"
                    role="tab"
                    :aria-selected="mode === 'sideload'"
                    class="flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
                    :class="mode === 'sideload' ? 'bg-base-700 text-base-50' : 'text-base-400 hover:text-base-100'"
                    @click="mode = 'sideload'"
                >
                    <Smartphone class="size-3.5" /> HP yang sudah dipakai
                </button>
                <button
                    type="button"
                    role="tab"
                    :aria-selected="mode === 'owner'"
                    class="flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
                    :class="mode === 'owner' ? 'bg-base-700 text-base-50' : 'text-base-400 hover:text-base-100'"
                    @click="mode = 'owner'"
                >
                    <ShieldCheck class="size-3.5" /> HP kantor baru (QR)
                </button>
            </div>

            <p class="rounded-lg border border-base-700 bg-base-850 p-3 text-xs text-pretty text-base-300">
                Satu APK = satu HP. Identitas device sudah tertanam, jadi APK ini langsung terdaftar ke site
                <strong class="text-base-100">{{ build.organization_name ?? build.embedded_site_code }}</strong> tanpa kode pairing.
                Pasang hanya di HP aset kantor yang pemegangnya sudah menandatangani persetujuan.
            </p>

            <ol v-if="mode === 'sideload'" class="list-decimal space-y-2 pl-5 text-sm text-pretty text-base-200">
                <li v-for="step in SIDELOAD_STEPS" :key="step">{{ step }}</li>
            </ol>

            <template v-else>
                <ol class="list-decimal space-y-2 pl-5 text-sm text-pretty text-base-200">
                    <li v-for="step in OWNER_STEPS" :key="step">{{ step }}</li>
                </ol>
                <div class="flex flex-col items-center gap-3 rounded-lg border border-base-800 p-4">
                    <img
                        v-if="qrSrc"
                        :src="qrSrc"
                        alt="QR provisioning Device Owner"
                        class="size-64 rounded-md bg-white p-2"
                    />
                    <BaseButton v-else :loading="loadingQr" @click="loadQr"><QrCode class="size-4" /> Tampilkan QR</BaseButton>
                    <p v-if="provisioning" class="text-center text-xs text-pretty text-warning-400">
                        Berlaku sampai {{ dayjs(provisioning.expires_at).format('DD MMM HH:mm') }}. QR berisi tautan unduh APK beserta
                        kunci device — jangan difoto atau dibagikan; tampilkan hanya saat memasang.
                    </p>
                </div>
            </template>
        </div>
        <template #footer>
            <a
                v-if="build?.download_url && mode === 'sideload'"
                :href="build.download_url"
                class="inline-flex h-9 items-center rounded-lg border border-base-700 px-3 text-sm font-medium text-base-100 hover:bg-base-850"
                >Unduh APK</a
            >
            <BaseButton variant="outline" @click="emit('close')">Tutup</BaseButton>
        </template>
    </BaseDialog>
</template>
