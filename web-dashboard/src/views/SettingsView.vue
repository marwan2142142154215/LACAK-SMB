<script setup>
import { ShieldAlert, ShieldCheck } from '@lucide/vue'
import { onMounted, ref } from 'vue'

import IpWhitelistCard from '@/components/settings/IpWhitelistCard.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import StatusDot from '@/components/ui/StatusDot.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'

const toast = useToast()

const twoFactorRequired = ref(null)
const loading = ref(true)
const saving = ref(false)
const confirmDisableOpen = ref(false)

async function loadSettings() {
    loading.value = true
    try {
        const response = await api.get('/settings/security')
        twoFactorRequired.value = response.data.data.two_factor_required
    } catch (err) {
        toast.error('Gagal memuat pengaturan', err.response?.data?.message)
    } finally {
        loading.value = false
    }
}

async function saveTwoFactor(required) {
    saving.value = true
    try {
        const response = await api.put('/settings/security', { two_factor_required: required })
        twoFactorRequired.value = response.data.data.two_factor_required
        toast.success(response.data.message)
        confirmDisableOpen.value = false
    } catch (err) {
        toast.error('Gagal menyimpan pengaturan', err.response?.data?.message)
    } finally {
        saving.value = false
    }
}

// Mematikan 2FA melemahkan semua akun sekaligus -- minta konfirmasi dulu;
// menyalakannya kembali langsung tanpa konfirmasi.
function toggleTwoFactor() {
    if (twoFactorRequired.value) confirmDisableOpen.value = true
    else saveTwoFactor(true)
}

onMounted(loadSettings)
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Akses"
            title="Pengaturan"
            subtitle="Aturan keamanan yang berlaku untuk semua akun. Hanya Super Admin yang bisa mengubahnya."
        />

        <div class="max-w-3xl space-y-6 p-4 sm:p-8">
            <BaseCard title="Keamanan login">
                <div v-if="loading" class="py-6 text-center text-sm text-base-500">Memuat pengaturan…</div>
                <div v-else class="flex items-start justify-between gap-6">
                    <div class="flex min-w-0 gap-4">
                        <span
                            class="flex size-10 shrink-0 items-center justify-center rounded-md"
                            :class="twoFactorRequired ? 'bg-accent-500/10 text-accent-400' : 'bg-warning-500/10 text-warning-400'"
                        >
                            <ShieldCheck v-if="twoFactorRequired" class="size-5" />
                            <ShieldAlert v-else class="size-5" />
                        </span>
                        <div class="min-w-0">
                            <p class="font-medium text-base-50">Wajibkan 2FA saat login</p>
                            <p class="mt-1 text-sm text-pretty text-base-400">
                                Setelah password, staf memasukkan kode 6 digit dari aplikasi authenticator. Berlaku untuk dashboard dan APK
                                Master.
                            </p>
                            <div class="mt-3">
                                <StatusDot
                                    :status="twoFactorRequired ? 'active' : 'pending'"
                                    :label="
                                        twoFactorRequired
                                            ? 'Aktif: semua login memakai kode authenticator'
                                            : 'Mati: login cukup dengan password'
                                    "
                                />
                            </div>
                            <p
                                v-if="!twoFactorRequired"
                                class="mt-3 rounded-lg border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-xs text-pretty text-warning-400"
                            >
                                Gunakan mode ini hanya di server uji. Authenticator yang sudah dipasang staf tetap tersimpan dan langsung
                                dipakai lagi begitu 2FA dinyalakan.
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        :aria-checked="twoFactorRequired"
                        aria-label="Wajibkan 2FA saat login"
                        :disabled="saving"
                        class="relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400 disabled:opacity-50"
                        :class="twoFactorRequired ? 'bg-accent-500' : 'bg-base-700'"
                        @click="toggleTwoFactor"
                    >
                        <span
                            class="absolute top-0.5 left-0.5 size-5 rounded-full bg-base-50 shadow transition-transform"
                            :class="twoFactorRequired ? 'translate-x-5' : 'translate-x-0'"
                        />
                    </button>
                </div>
            </BaseCard>

            <IpWhitelistCard />
        </div>

        <ConfirmDialog
            v-model:open="confirmDisableOpen"
            title="Matikan 2FA untuk semua akun?"
            description="Siapa pun yang tahu username dan password bisa langsung masuk tanpa kode authenticator. Nyalakan kembali sebelum dipakai di server produksi."
            confirm-label="Matikan 2FA"
            :loading="saving"
            @confirm="saveTwoFactor(false)"
        />
    </div>
</template>
