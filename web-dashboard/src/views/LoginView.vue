<script setup>
import { ArrowLeft, Copy, LockKeyhole } from '@lucide/vue'
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'

import CodeCells from '@/components/auth/CodeCells.vue'
import LoginRadar from '@/components/auth/LoginRadar.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useToast } from '@/composables/useToast'
import { LOGIN_REDIRECT_KEY } from '@/router'
import { useAuthStore } from '@/stores/auth'

// step: 'credentials' -> 'setup_2fa' (QR, hanya login pertama) -> 'recovery_codes'
//       'credentials' -> 'verify_2fa' (login berikutnya)
const step = ref('credentials')

const username = ref('')
const password = ref('')
const code = ref('')
const recoveryCode = ref('')
const useRecoveryCode = ref(false)
const loading = ref(false)
const granted = ref(false)
const errorMessage = ref('')

const setupToken = ref(null)
const challengeToken = ref(null)
const qrCodeSvg = ref(null)
const secretManualEntry = ref(null)
const recoveryCodes = ref(null)

const codeCells = ref(null)

const auth = useAuthStore()
const router = useRouter()
const toast = useToast()

const STEPS = [
    { key: 'account', label: 'Akun' },
    { key: 'authenticator', label: 'Authenticator' },
    { key: 'access', label: 'Masuk' },
]

const stepIndex = computed(() => {
    if (granted.value) return 2
    return step.value === 'credentials' ? 0 : 1
})

const radarPhase = computed(() => ['identity', 'authenticator', 'granted'][stepIndex.value])

const radarStatus = computed(
    () =>
        ({
            identity: 'Menunggu identitas',
            authenticator: 'Menunggu kode authenticator',
            granted: 'Akses diberikan',
        })[radarPhase.value],
)

const qrDataUri = computed(() => {
    if (!qrCodeSvg.value) return null
    return `data:image/svg+xml;utf8,${encodeURIComponent(qrCodeSvg.value)}`
})

// Kunci manual dipecah per 4 karakter supaya mudah diketik ulang dari layar.
const groupedSecret = computed(() => secretManualEntry.value?.match(/.{1,4}/g)?.join(' ') ?? '')

function enter() {
    granted.value = true
    const target = sessionStorage.getItem(LOGIN_REDIRECT_KEY)
    sessionStorage.removeItem(LOGIN_REDIRECT_KEY)
    // Hanya path internal ("/..."), bukan "//host" -- jangan pernah keluar aplikasi.
    router.push(target?.startsWith('/') && !target.startsWith('//') ? target : { name: 'radar' })
}

async function failCode(err, fallback) {
    errorMessage.value = err.response?.data?.message ?? fallback
    code.value = ''
    await nextTick()
    codeCells.value?.focus()
}

async function handleCredentialsSubmit() {
    errorMessage.value = ''
    loading.value = true
    try {
        const data = await auth.login(username.value.trim(), password.value)
        code.value = ''

        if (data.requires_2fa_setup) {
            setupToken.value = data.setup_token
            qrCodeSvg.value = data.qr_code_svg
            secretManualEntry.value = data.secret_manual_entry
            step.value = 'setup_2fa'
        } else if (data.requires_2fa) {
            challengeToken.value = data.challenge_token
            step.value = 'verify_2fa'
        } else if (data.access_token) {
            // 2FA sedang dimatikan super_admin -- sesi sudah disiapkan store.
            enter()
        }
    } catch (err) {
        errorMessage.value = err.response?.data?.message ?? 'Server tidak merespons. Periksa koneksi lalu coba lagi.'
    } finally {
        loading.value = false
    }
}

// Kode bisa terkirim dua kali dari satu ketikan: otomatis di digit ke-6
// (CodeCells @complete) DAN lewat tombol "Go"/isi otomatis kode di keyboard
// iPhone. Kiriman kedua yang datang setelah yang pertama sukses ditolak
// backend (410, challenge sudah terpakai) dan dulu membuang user ke langkah
// awal -- jadi setelah sukses, kiriman berikutnya diabaikan.
async function handleSetupConfirm() {
    if (loading.value || recoveryCodes.value || code.value.length !== 6) return
    errorMessage.value = ''
    loading.value = true
    try {
        const data = await auth.confirmTwoFactorSetup(setupToken.value, code.value)
        recoveryCodes.value = data.recovery_codes
        step.value = 'recovery_codes'
    } catch (err) {
        await failCode(err, 'Kode tidak cocok. Masukkan kode yang sedang tampil di aplikasi authenticator.')
    } finally {
        loading.value = false
    }
}

async function handleVerifyConfirm() {
    const submitted = useRecoveryCode.value ? recoveryCode.value.trim() : code.value
    if (loading.value || granted.value || !submitted || (!useRecoveryCode.value && submitted.length !== 6)) return
    errorMessage.value = ''
    loading.value = true
    try {
        await auth.verifyTwoFactor(challengeToken.value, submitted)
        enter()
    } catch (err) {
        if (useRecoveryCode.value) {
            errorMessage.value = err.response?.data?.message ?? 'Kode pemulihan tidak dikenali.'
        } else {
            await failCode(err, 'Kode tidak cocok. Masukkan kode yang sedang tampil di aplikasi authenticator.')
        }
        // Batas percobaan habis / sesi kedaluwarsa -> harus mulai dari awal.
        if ([410, 429].includes(err.response?.status)) backToCredentials(false)
    } finally {
        loading.value = false
    }
}

async function toggleRecoveryCode() {
    useRecoveryCode.value = !useRecoveryCode.value
    errorMessage.value = ''
    code.value = ''
    recoveryCode.value = ''
    if (!useRecoveryCode.value) {
        await nextTick()
        codeCells.value?.focus()
    }
}

function backToCredentials(clearError = true) {
    step.value = 'credentials'
    password.value = ''
    code.value = ''
    recoveryCode.value = ''
    useRecoveryCode.value = false
    setupToken.value = null
    challengeToken.value = null
    if (clearError) errorMessage.value = ''
}

async function copyText(text, message) {
    try {
        await navigator.clipboard.writeText(text)
        toast.success(message)
    } catch {
        toast.error('Gagal menyalin', 'Salin manual dari layar')
    }
}
</script>

<template>
    <div class="grid min-h-dvh bg-base-950 lg:grid-cols-[minmax(0,1.2fr)_minmax(26rem,1fr)]">
        <!-- Panel instrumen: radar BLE, sama seperti yang dilihat admin setelah masuk -->
        <section
            class="relative isolate flex flex-col overflow-hidden border-b border-base-800 bg-base-900 px-6 pt-6 pb-8 sm:px-10 lg:border-r lg:border-b-0 lg:py-10"
        >
            <div class="flex items-center justify-between font-mono text-[11px] tracking-[0.18em] text-base-400 uppercase">
                <span><span class="text-base-50">Lacak</span> SMB</span>
                <span class="hidden sm:inline">BLE 2.4 GHz · GPS</span>
            </div>

            <div
                class="pointer-events-none absolute top-1/2 -right-24 -z-10 w-[19rem] -translate-y-1/2 sm:-right-10 lg:static lg:z-auto lg:mx-auto lg:my-auto lg:w-[min(100%,34rem,calc(100dvh-27rem))] lg:translate-y-0 lg:py-6"
            >
                <LoginRadar :phase="radarPhase" />
            </div>

            <div class="mt-16 max-w-md lg:mt-0">
                <h1
                    class="font-display text-[2rem] leading-[1.05] font-semibold tracking-[-0.02em] text-balance text-base-50 sm:text-4xl xl:text-5xl"
                >
                    Semua perangkat kantor, dalam satu jangkauan.
                </h1>
                <p class="mt-3 max-w-sm text-sm text-pretty text-base-400">
                    Lokasi, status, dan Live Kerja tiap site — hanya untuk staf yang terdaftar.
                </p>
                <p class="mt-6 flex items-center gap-2 font-mono text-[11px] tracking-[0.14em] uppercase" role="status">
                    <span
                        class="size-1.5 rounded-full"
                        :class="granted ? 'bg-accent-300' : stepIndex === 1 ? 'bg-copper-400' : 'bg-base-400'"
                    />
                    <span class="text-base-500">Status</span>
                    <span class="text-base-200">{{ radarStatus }}</span>
                </p>
            </div>
        </section>

        <main class="flex items-center justify-center px-6 py-10 sm:px-10">
            <div class="w-full max-w-sm">
                <ol class="mb-10 grid grid-cols-3 gap-2" aria-label="Tahap masuk">
                    <li v-for="(item, i) in STEPS" :key="item.key" :aria-current="i === stepIndex ? 'step' : undefined">
                        <span
                            class="block h-0.5 rounded-full transition-colors duration-500"
                            :class="i < stepIndex ? 'bg-accent-500/60' : i === stepIndex ? 'bg-accent-400' : 'bg-base-800'"
                        />
                        <span
                            class="mt-2 block font-mono text-[10px] tracking-[0.14em] uppercase transition-colors"
                            :class="i === stepIndex ? 'text-base-100' : 'text-base-500'"
                        >
                            {{ item.label }}
                        </span>
                    </li>
                </ol>

                <!-- Tahap 1: akun -->
                <form v-if="step === 'credentials'" class="space-y-5" @submit.prevent="handleCredentialsSubmit">
                    <header>
                        <h2 class="font-display text-2xl font-semibold tracking-[-0.01em] text-base-50">Masuk</h2>
                        <p class="mt-1.5 text-sm text-base-400">Pakai email Account Center perusahaan, atau username untuk akun layanan.</p>
                    </header>
                    <BaseInput
                        v-model="username"
                        label="Email atau username"
                        placeholder="nama@perusahaan.com"
                        autocomplete="username"
                        autocapitalize="none"
                        autocorrect="off"
                        spellcheck="false"
                        required
                    />
                    <BaseInput v-model="password" label="Password" type="password" autocomplete="current-password" required />
                    <p v-if="errorMessage" class="text-sm text-danger-400" role="alert">{{ errorMessage }}</p>
                    <BaseButton type="submit" class="w-full" :loading="loading">Lanjut</BaseButton>
                    <p class="flex items-start gap-2 border-t border-base-800 pt-5 text-xs text-base-500">
                        <LockKeyhole class="mt-px size-3.5 shrink-0 text-copper-400" />
                        Bila 2FA aktif, login dilanjutkan dengan kode dari aplikasi authenticator.
                    </p>
                </form>

                <!-- Tahap 2a: pasang authenticator (login pertama) -->
                <form v-else-if="step === 'setup_2fa'" class="space-y-5" @submit.prevent="handleSetupConfirm">
                    <header>
                        <h2 class="font-display text-2xl font-semibold tracking-[-0.01em] text-base-50">Pasang authenticator</h2>
                        <p class="mt-1.5 text-sm text-base-400">
                            Pindai QR dengan Google Authenticator atau Authy, lalu masukkan 6 digit yang muncul.
                        </p>
                    </header>

                    <div class="flex items-center gap-5">
                        <div class="viewfinder relative shrink-0 rounded-lg bg-white p-2.5">
                            <img :src="qrDataUri" alt="Kode QR untuk aplikasi authenticator" class="size-36" />
                        </div>
                        <div class="min-w-0 text-xs text-base-400">
                            <p>Tidak bisa memindai? Ketik kunci ini di aplikasi:</p>
                            <p class="mt-2 font-mono text-[13px] leading-relaxed break-words text-base-100">{{ groupedSecret }}</p>
                            <button
                                type="button"
                                class="mt-2 inline-flex items-center gap-1.5 rounded text-accent-400 hover:text-accent-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400"
                                @click="copyText(secretManualEntry, 'Kunci disalin')"
                            >
                                <Copy class="size-3.5" /> Salin kunci
                            </button>
                        </div>
                    </div>

                    <CodeCells
                        ref="codeCells"
                        v-model="code"
                        label="Kode 6 digit dari authenticator"
                        :invalid="!!errorMessage"
                        :disabled="loading"
                        @complete="handleSetupConfirm"
                    />
                    <p v-if="errorMessage" class="text-sm text-danger-400" role="alert">{{ errorMessage }}</p>
                    <BaseButton type="submit" class="w-full" :loading="loading" :disabled="code.length !== 6">Aktifkan 2FA</BaseButton>
                    <button type="button" class="back-link" @click="backToCredentials()"><ArrowLeft class="size-3.5" /> Ganti akun</button>
                </form>

                <!-- Tahap 2a-lanjutan: kode pemulihan, ditampilkan sekali -->
                <div v-else-if="step === 'recovery_codes'" class="space-y-5">
                    <header>
                        <h2 class="font-display text-2xl font-semibold tracking-[-0.01em] text-base-50">Simpan kode pemulihan</h2>
                        <p class="mt-1.5 text-sm text-base-400">
                            Dipakai untuk masuk kalau HP authenticator hilang. Tiap kode berlaku sekali, dan daftar ini tidak akan
                            ditampilkan lagi.
                        </p>
                    </header>
                    <ul
                        class="grid grid-cols-2 gap-x-6 gap-y-2.5 rounded-lg border border-dashed border-copper-500/40 bg-base-900 px-5 py-4 font-mono text-sm text-base-100"
                    >
                        <li v-for="rc in recoveryCodes" :key="rc">{{ rc }}</li>
                    </ul>
                    <BaseButton variant="outline" class="w-full" @click="copyText(recoveryCodes.join('\n'), 'Kode pemulihan disalin')">
                        <Copy class="size-4" /> Salin semua kode
                    </BaseButton>
                    <BaseButton class="w-full" @click="enter">Sudah disimpan, masuk</BaseButton>
                </div>

                <!-- Tahap 2b: kode authenticator (login berikutnya) -->
                <form v-else-if="step === 'verify_2fa'" class="space-y-5" @submit.prevent="handleVerifyConfirm">
                    <header>
                        <h2 class="font-display text-2xl font-semibold tracking-[-0.01em] text-base-50">
                            {{ useRecoveryCode ? 'Kode pemulihan' : 'Kode authenticator' }}
                        </h2>
                        <p class="mt-1.5 text-sm text-base-400">
                            <template v-if="useRecoveryCode"
                                >Masukkan salah satu kode pemulihan yang Anda simpan saat memasang 2FA.</template
                            >
                            <template v-else>
                                Buka aplikasi authenticator dan masukkan 6 digit untuk <span class="text-base-200">{{ username }}</span
                                >.
                            </template>
                        </p>
                    </header>

                    <BaseInput
                        v-if="useRecoveryCode"
                        v-model="recoveryCode"
                        label="Kode pemulihan"
                        autocomplete="off"
                        maxlength="40"
                        required
                    />
                    <CodeCells
                        v-else
                        ref="codeCells"
                        v-model="code"
                        label="Kode 6 digit dari authenticator"
                        :invalid="!!errorMessage"
                        :disabled="loading"
                        @complete="handleVerifyConfirm"
                    />

                    <p v-if="errorMessage" class="text-sm text-danger-400" role="alert">{{ errorMessage }}</p>
                    <BaseButton
                        type="submit"
                        class="w-full"
                        :loading="loading"
                        :disabled="useRecoveryCode ? !recoveryCode.trim() : code.length !== 6"
                    >
                        Verifikasi
                    </BaseButton>
                    <div class="flex items-center justify-between">
                        <button type="button" class="back-link" @click="backToCredentials()">
                            <ArrowLeft class="size-3.5" /> Ganti akun
                        </button>
                        <button type="button" class="back-link" @click="toggleRecoveryCode">
                            {{ useRecoveryCode ? 'Pakai kode authenticator' : 'Pakai kode pemulihan' }}
                        </button>
                    </div>
                </form>
            </div>
        </main>
    </div>
</template>

<style scoped>
@reference '../style.css';

.back-link {
    @apply inline-flex items-center gap-1.5 rounded text-xs text-base-400 transition-colors hover:text-base-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400;
}

/* Sudut bidik kamera di sekeliling QR -- isyarat "pindai ini" */
.viewfinder::before {
    content: '';
    position: absolute;
    inset: -8px;
    --c: var(--color-copper-400);
    --l: 14px;
    background:
        linear-gradient(var(--c), var(--c)) top left / var(--l) 2px,
        linear-gradient(var(--c), var(--c)) top left / 2px var(--l),
        linear-gradient(var(--c), var(--c)) top right / var(--l) 2px,
        linear-gradient(var(--c), var(--c)) top right / 2px var(--l),
        linear-gradient(var(--c), var(--c)) bottom left / var(--l) 2px,
        linear-gradient(var(--c), var(--c)) bottom left / 2px var(--l),
        linear-gradient(var(--c), var(--c)) bottom right / var(--l) 2px,
        linear-gradient(var(--c), var(--c)) bottom right / 2px var(--l);
    background-repeat: no-repeat;
    pointer-events: none;
}
</style>
