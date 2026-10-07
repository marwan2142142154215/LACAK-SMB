<script setup>
import { KeyRound, ShieldCheck } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'

// step: 'credentials' -> 'setup_2fa' (QR, hanya login pertama) -> 'verify_2fa'
const step = ref('credentials')

const username = ref('')
const password = ref('')
const code = ref('')
const loading = ref(false)
const errorMessage = ref('')

const setupToken = ref(null)
const challengeToken = ref(null)
const qrCodeSvg = ref(null)
const secretManualEntry = ref(null)
const recoveryCodes = ref(null)

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const toast = useToast()

const qrDataUri = computed(() => {
    if (!qrCodeSvg.value) return null
    return `data:image/svg+xml;utf8,${encodeURIComponent(qrCodeSvg.value)}`
})

async function handleCredentialsSubmit() {
    errorMessage.value = ''
    loading.value = true
    try {
        const data = await auth.login(username.value, password.value)

        if (data.requires_2fa_setup) {
            setupToken.value = data.setup_token
            qrCodeSvg.value = data.qr_code_svg
            secretManualEntry.value = data.secret_manual_entry
            step.value = 'setup_2fa'
        } else if (data.requires_2fa) {
            challengeToken.value = data.challenge_token
            step.value = 'verify_2fa'
        }
    } catch (err) {
        errorMessage.value = err.response?.data?.message ?? 'Gagal masuk, periksa koneksi Anda'
    } finally {
        loading.value = false
    }
}

async function handleSetupConfirm() {
    errorMessage.value = ''
    loading.value = true
    try {
        const data = await auth.confirmTwoFactorSetup(setupToken.value, code.value)
        recoveryCodes.value = data.recovery_codes
        toast.success('2FA berhasil diaktifkan', 'Simpan kode pemulihan di tempat aman')
    } catch (err) {
        errorMessage.value = err.response?.data?.message ?? 'Kode 2FA salah'
    } finally {
        loading.value = false
    }
}

async function handleVerifyConfirm() {
    errorMessage.value = ''
    loading.value = true
    try {
        await auth.verifyTwoFactor(challengeToken.value, code.value)
        router.push(route.query.redirect ?? { name: 'radar' })
    } catch (err) {
        errorMessage.value = err.response?.data?.message ?? 'Kode 2FA salah'
    } finally {
        loading.value = false
    }
}

function finishAfterRecoveryCodes() {
    router.push(route.query.redirect ?? { name: 'radar' })
}
</script>

<template>
    <div class="flex min-h-screen items-center justify-center bg-base-950 px-4">
        <div class="pointer-events-none fixed inset-0 overflow-hidden">
            <div class="absolute -top-32 -left-32 size-96 rounded-full bg-accent-500/10 blur-3xl" />
            <div class="absolute -right-32 -bottom-32 size-96 rounded-full bg-copper-500/10 blur-3xl" />
        </div>

        <div class="relative w-full max-w-sm">
            <div class="mb-8 flex flex-col items-center text-center">
                <div class="mb-4 flex size-14 items-center justify-center rounded-2xl bg-accent-500/15 ring-1 ring-accent-500/30">
                    <ShieldCheck class="size-7 text-accent-400" />
                </div>
                <h1 class="text-xl font-bold text-base-50">Lacak Master</h1>
                <p class="mt-1 text-sm text-base-400">Masuk untuk mengelola pemantauan & pelacakan</p>
            </div>

            <div class="rounded-2xl border border-base-800 bg-base-900/70 p-7 shadow-2xl shadow-black/30 backdrop-blur">
                <!-- Step 1: username + password -->
                <form v-if="step === 'credentials'" class="space-y-4" @submit.prevent="handleCredentialsSubmit">
                    <BaseInput v-model="username" label="Username" placeholder="marwanmaster" autocomplete="username" required />
                    <BaseInput
                        v-model="password"
                        label="Password"
                        type="password"
                        placeholder="••••••••"
                        autocomplete="current-password"
                        required
                    />
                    <p v-if="errorMessage" class="text-sm text-danger-400">{{ errorMessage }}</p>
                    <BaseButton type="submit" class="w-full" :loading="loading">Masuk</BaseButton>
                </form>

                <!-- Step 2a: enrollment 2FA (hanya login pertama kali) -->
                <div v-else-if="step === 'setup_2fa' && !recoveryCodes" class="space-y-4">
                    <div class="text-center">
                        <p class="text-sm font-medium text-base-100">Aktifkan 2FA</p>
                        <p class="mt-1 text-xs text-base-400">
                            Scan QR ini dengan Google Authenticator / Authy, lalu masukkan kode 6 digit untuk konfirmasi.
                        </p>
                    </div>
                    <div class="flex justify-center rounded-xl bg-white p-3">
                        <img :src="qrDataUri" alt="QR 2FA" class="size-48" />
                    </div>
                    <p class="text-center font-mono text-xs break-all text-base-500">{{ secretManualEntry }}</p>
                    <form class="space-y-4" @submit.prevent="handleSetupConfirm">
                        <BaseInput v-model="code" label="Kode 6 digit" placeholder="000000" required />
                        <p v-if="errorMessage" class="text-sm text-danger-400">{{ errorMessage }}</p>
                        <BaseButton type="submit" class="w-full" :loading="loading">Konfirmasi & Aktifkan</BaseButton>
                    </form>
                </div>

                <!-- Step 2a-lanjutan: tampilkan recovery codes sekali setelah enrollment -->
                <div v-else-if="recoveryCodes" class="space-y-4">
                    <div class="text-center">
                        <KeyRound class="mx-auto size-8 text-warning-400" />
                        <p class="mt-2 text-sm font-medium text-base-100">Simpan Kode Pemulihan Anda</p>
                        <p class="mt-1 text-xs text-base-400">Kode ini hanya ditampilkan sekali. Simpan di tempat aman.</p>
                    </div>
                    <div class="grid grid-cols-2 gap-2 rounded-xl bg-base-850 p-4 font-mono text-xs text-base-200">
                        <span v-for="rc in recoveryCodes" :key="rc">{{ rc }}</span>
                    </div>
                    <BaseButton class="w-full" @click="finishAfterRecoveryCodes">Sudah saya simpan, lanjutkan</BaseButton>
                </div>

                <!-- Step 2b: verifikasi 2FA (login berikutnya) -->
                <form v-else-if="step === 'verify_2fa'" class="space-y-4" @submit.prevent="handleVerifyConfirm">
                    <div class="text-center">
                        <p class="text-sm font-medium text-base-100">Verifikasi 2FA</p>
                        <p class="mt-1 text-xs text-base-400">Masukkan kode dari aplikasi authenticator Anda</p>
                    </div>
                    <BaseInput v-model="code" label="Kode 6 digit" placeholder="000000" required />
                    <p v-if="errorMessage" class="text-sm text-danger-400">{{ errorMessage }}</p>
                    <BaseButton type="submit" class="w-full" :loading="loading">Verifikasi</BaseButton>
                </form>
            </div>
        </div>
    </div>
</template>
