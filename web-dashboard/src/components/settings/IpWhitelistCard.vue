<script setup>
import { Network, Plus, Trash2 } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import StatusDot from '@/components/ui/StatusDot.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'

const toast = useToast()

const loading = ref(true)
const saving = ref(false)
const confirmEnableOpen = ref(false)

// Yang tersimpan di server vs yang sedang disunting.
const saved = ref({ enabled: false, entries: [] })
const enabled = ref(false)
const entries = ref([])
const currentIp = ref('')
const currentIpAllowed = ref(false)
const errors = ref({})

let nextKey = 0
const row = (entry = { value: '', label: '' }) => ({ key: nextKey++, value: entry.value, label: entry.label })

const cleaned = computed(() =>
    entries.value
        .map((entry) => ({ value: entry.value.trim(), label: entry.label.trim() }))
        .filter((entry) => entry.value !== '' || entry.label !== ''),
)
const dirty = computed(() => enabled.value !== saved.value.enabled || JSON.stringify(cleaned.value) !== JSON.stringify(saved.value.entries))
const hasMyIp = computed(() => entries.value.some((entry) => entry.value.trim() === currentIp.value))

function apply(data) {
    saved.value = { enabled: data.enabled, entries: data.entries }
    enabled.value = data.enabled
    entries.value = data.entries.length ? data.entries.map(row) : [row()]
    currentIp.value = data.current_ip
    currentIpAllowed.value = data.current_ip_allowed
    errors.value = {}
}

async function load() {
    loading.value = true
    try {
        const response = await api.get('/settings/ip-whitelist')
        apply(response.data.data)
    } catch (err) {
        toast.error('Gagal memuat whitelist IP', err.response?.data?.message)
    } finally {
        loading.value = false
    }
}

function addRow(entry) {
    // Baris kosong terakhir dipakai ulang, jangan menumpuk baris kosong.
    const blank = entries.value.find((item) => item.value.trim() === '' && item.label.trim() === '')
    if (!blank) entries.value.push(row(entry))
    else if (entry) Object.assign(blank, entry)
}

function removeRow(key) {
    entries.value = entries.value.filter((entry) => entry.key !== key)
    if (!entries.value.length) entries.value.push(row())
}

function fieldError(index, field) {
    return errors.value[`entries.${index}.${field}`]?.[0] ?? null
}

// Indeks error dari server mengikuti daftar yang dikirim (cleaned), bukan baris di layar.
const sentIndexOf = computed(() => {
    const map = new Map()
    let sent = 0
    for (const entry of entries.value) {
        if (entry.value.trim() !== '' || entry.label.trim() !== '') map.set(entry.key, sent++)
    }
    return map
})

function requestSave() {
    // Mengaktifkan (dari mati) langsung memutus user di luar daftar -- konfirmasi dulu.
    if (enabled.value && !saved.value.enabled) confirmEnableOpen.value = true
    else save()
}

async function save() {
    saving.value = true
    try {
        const response = await api.put('/settings/ip-whitelist', { enabled: enabled.value, entries: cleaned.value })
        apply(response.data.data)
        toast.success(response.data.message)
        confirmEnableOpen.value = false
    } catch (err) {
        errors.value = err.response?.data?.errors ?? {}
        confirmEnableOpen.value = false
        toast.error('Gagal menyimpan whitelist IP', errors.value.entries?.[0] ?? err.response?.data?.message)
    } finally {
        saving.value = false
    }
}

onMounted(load)
</script>

<template>
    <BaseCard title="Whitelist IP">
        <div v-if="loading" class="py-6 text-center text-sm text-base-500">Memuat whitelist…</div>
        <div v-else class="space-y-5">
            <div class="flex items-start justify-between gap-6">
                <div class="flex min-w-0 gap-4">
                    <span
                        class="flex size-10 shrink-0 items-center justify-center rounded-md"
                        :class="saved.enabled ? 'bg-accent-500/10 text-accent-400' : 'bg-base-800 text-base-400'"
                    >
                        <Network class="size-5" />
                    </span>
                    <div class="min-w-0">
                        <p class="font-medium text-base-50">Batasi akses ke IP terdaftar</p>
                        <p class="mt-1 text-sm text-pretty text-base-400">
                            Login dan setiap permintaan dari dashboard, APK Master, dan APK Live Kerja hanya diterima dari IP di bawah. User
                            yang pindah ke jaringan lain langsung keluar. Super Admin dan akun bot Telegram tidak dibatasi.
                        </p>
                        <div class="mt-3">
                            <StatusDot
                                :status="saved.enabled ? 'active' : 'pending'"
                                :label="
                                    saved.enabled ? `Aktif: ${saved.entries.length} IP/rentang diizinkan` : 'Mati: akses dari IP mana saja'
                                "
                            />
                        </div>
                    </div>
                </div>
                <button
                    type="button"
                    role="switch"
                    :aria-checked="enabled"
                    aria-label="Aktifkan whitelist IP"
                    :disabled="saving"
                    class="relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400 disabled:opacity-50"
                    :class="enabled ? 'bg-accent-500' : 'bg-base-700'"
                    @click="enabled = !enabled"
                >
                    <span
                        class="absolute top-0.5 left-0.5 size-5 rounded-full bg-base-50 shadow transition-transform"
                        :class="enabled ? 'translate-x-5' : 'translate-x-0'"
                    />
                </button>
            </div>

            <div class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-base-800 bg-base-900/60 px-3 py-2.5 text-sm">
                <span class="text-base-400">IP Anda saat ini</span>
                <span class="font-mono text-base-50 tabular-nums">{{ currentIp || '—' }}</span>
                <BaseButton
                    v-if="currentIp && !hasMyIp"
                    variant="outline"
                    size="sm"
                    class="ml-auto"
                    @click="addRow({ value: currentIp, label: 'Kantor' })"
                >
                    <Plus class="size-3.5" /> Tambahkan IP saya
                </BaseButton>
            </div>

            <p
                v-if="saved.enabled && !currentIpAllowed"
                class="rounded-lg border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-xs text-pretty text-warning-400"
            >
                IP Anda tidak termasuk daftar. Anda tetap bisa masuk karena Super Admin, tapi akun lain dari jaringan ini akan ditolak.
            </p>

            <div>
                <div class="mb-2 hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.25rem] gap-2 text-xs font-medium text-base-500 sm:grid">
                    <span>Alamat IP atau rentang CIDR</span>
                    <span>Keterangan</span>
                </div>
                <ul class="space-y-2">
                    <li
                        v-for="entry in entries"
                        :key="entry.key"
                        class="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.25rem]"
                    >
                        <BaseInput
                            v-model="entry.value"
                            placeholder="103.10.20.30 atau 192.168.1.0/24"
                            aria-label="Alamat IP atau rentang CIDR"
                            class="font-mono"
                            maxlength="64"
                            :error="sentIndexOf.has(entry.key) ? fieldError(sentIndexOf.get(entry.key), 'value') : null"
                        />
                        <BaseInput
                            v-model="entry.label"
                            placeholder="mis. Kantor pusat"
                            aria-label="Keterangan"
                            maxlength="60"
                            class="max-sm:col-start-1 max-sm:row-start-2"
                            :error="sentIndexOf.has(entry.key) ? fieldError(sentIndexOf.get(entry.key), 'label') : null"
                        />
                        <BaseButton
                            variant="ghost"
                            size="icon"
                            class="mt-0.5 sm:mt-0"
                            :aria-label="`Hapus ${entry.value || 'baris ini'}`"
                            @click="removeRow(entry.key)"
                        >
                            <Trash2 class="size-4" />
                        </BaseButton>
                    </li>
                </ul>
                <BaseButton variant="ghost" size="sm" class="mt-2" @click="addRow()"> <Plus class="size-3.5" /> Tambah IP </BaseButton>
            </div>

            <div class="flex items-center justify-end gap-3 border-t border-base-800 pt-4">
                <span v-if="dirty" class="text-xs text-base-500">Ada perubahan yang belum disimpan</span>
                <BaseButton
                    variant="outline"
                    :disabled="!dirty || saving"
                    @click="apply({ ...saved, current_ip: currentIp, current_ip_allowed: currentIpAllowed })"
                >
                    Batalkan
                </BaseButton>
                <BaseButton :loading="saving" :disabled="!dirty" @click="requestSave">Simpan whitelist</BaseButton>
            </div>
        </div>

        <ConfirmDialog
            v-model:open="confirmEnableOpen"
            title="Aktifkan whitelist IP?"
            :description="`Hanya ${cleaned.length} IP/rentang di daftar yang bisa login dan memakai aplikasi. User lain, termasuk staf yang sedang siaran Live Kerja dari jaringan lain, langsung keluar.`"
            confirm-label="Aktifkan whitelist"
            confirm-variant="primary"
            :loading="saving"
            @confirm="save"
        />
    </BaseCard>
</template>
