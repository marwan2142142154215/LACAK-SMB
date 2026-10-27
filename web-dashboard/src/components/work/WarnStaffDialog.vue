<script setup>
import dayjs from 'dayjs'
import { ref, watch } from 'vue'

import BaseButton from '@/components/ui/BaseButton.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'

const props = defineProps({
    open: { type: Boolean, default: false },
    // { user_id, name } staf yang diberi peringatan
    staff: { type: Object, default: null },
})
const emit = defineEmits(['update:open'])

const LEVELS = [
    { value: 'teguran', label: 'Teguran', hint: 'Untuk pelanggaran ringan atau pertama kali.' },
    { value: 'keras', label: 'Peringatan keras', hint: 'Untuk pelanggaran berulang atau serius.' },
]

const toast = useToast()
const level = ref('teguran')
const message = ref('')
const sending = ref(false)
const history = ref([])
const loadingHistory = ref(false)

watch(
    () => [props.open, props.staff?.user_id],
    async ([open, userId]) => {
        if (!open || !userId) return
        level.value = 'teguran'
        message.value = ''
        loadingHistory.value = true
        try {
            const { data } = await api.get('/staff-warnings', { params: { user_id: userId } })
            history.value = data.data.items
        } catch {
            history.value = []
        } finally {
            loadingHistory.value = false
        }
    },
)

async function send() {
    sending.value = true
    try {
        await api.post('/staff-warnings', { user_id: props.staff.user_id, level: level.value, message: message.value })
        toast.success('Peringatan terkirim', `${props.staff.name} akan melihatnya sebagai popup di dashboard.`)
        emit('update:open', false)
    } catch (error) {
        toast.error('Peringatan belum terkirim', error.response?.data?.message ?? 'Periksa koneksi lalu coba lagi.')
    } finally {
        sending.value = false
    }
}
</script>

<template>
    <BaseDialog
        :open="open"
        :title="`Beri peringatan ke ${staff?.name ?? 'staf'}`"
        description="Muncul sebagai popup di dashboard staf dan harus dikonfirmasi sebelum ia bisa lanjut bekerja."
        size="lg"
        @update:open="(v) => emit('update:open', v)"
    >
        <form id="warn-staff-form" class="space-y-5" @submit.prevent="send">
            <fieldset>
                <legend class="field-label">Tingkat</legend>
                <div class="grid gap-2 sm:grid-cols-2">
                    <label
                        v-for="option in LEVELS"
                        :key="option.value"
                        class="flex cursor-pointer gap-3 rounded-xl border px-3.5 py-3 transition-colors"
                        :class="
                            level === option.value
                                ? option.value === 'keras'
                                    ? 'border-danger-500/60 bg-danger-500/8'
                                    : 'border-warning-500/60 bg-warning-500/8'
                                : 'border-base-700 hover:border-base-600'
                        "
                    >
                        <input v-model="level" type="radio" name="warning-level" :value="option.value" class="mt-1 accent-accent-500" />
                        <span>
                            <span class="block text-sm font-medium text-base-50">{{ option.label }}</span>
                            <span class="block text-xs text-base-500">{{ option.hint }}</span>
                        </span>
                    </label>
                </div>
            </fieldset>
            <label class="block">
                <span class="field-label">Pesan</span>
                <textarea
                    v-model="message"
                    class="field-control min-h-28 resize-y"
                    maxlength="1000"
                    required
                    minlength="3"
                    placeholder="Contoh: Kamera tertutup 15 menit saat jam kerja. Pastikan wajah terlihat selama bekerja."
                />
            </label>

            <div>
                <p class="field-label">Riwayat peringatan</p>
                <p v-if="loadingHistory" class="text-sm text-base-500">Memuat riwayat…</p>
                <p v-else-if="!history.length" class="text-sm text-base-500">Belum pernah diberi peringatan.</p>
                <ul v-else class="max-h-48 divide-y divide-base-800 overflow-y-auto rounded-xl border border-base-800">
                    <li v-for="item in history" :key="item.id" class="px-3.5 py-2.5">
                        <div class="flex items-center justify-between gap-3 text-xs">
                            <span class="font-medium" :class="item.level === 'keras' ? 'text-danger-400' : 'text-warning-400'">{{
                                item.level_label
                            }}</span>
                            <span class="text-base-500 tabular-nums">{{ dayjs(item.created_at).format('D MMM YYYY · HH:mm') }}</span>
                        </div>
                        <p class="mt-1 text-sm text-base-100">{{ item.message }}</p>
                        <p class="mt-1 text-xs text-base-500">
                            Oleh {{ item.issuer_name ?? '—' }} ·
                            <template v-if="item.acknowledged_at"
                                >dikonfirmasi {{ dayjs(item.acknowledged_at).format('D MMM · HH:mm') }}</template
                            >
                            <template v-else>belum dikonfirmasi</template>
                        </p>
                    </li>
                </ul>
            </div>
        </form>
        <template #footer>
            <BaseButton variant="ghost" :disabled="sending" @click="emit('update:open', false)">Batal</BaseButton>
            <BaseButton type="submit" form="warn-staff-form" :variant="level === 'keras' ? 'danger' : 'primary'" :loading="sending">
                Kirim peringatan
            </BaseButton>
        </template>
    </BaseDialog>
</template>
