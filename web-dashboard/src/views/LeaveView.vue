<script setup>
import { CalendarOff, Check, Plus, X } from '@lucide/vue'
import dayjs from 'dayjs'
import { computed, onMounted, ref, watch } from 'vue'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { refreshWorkCounters } from '@/lib/workCounters'

const toast = useToast()

const STATUS = {
    pending: { label: 'Menunggu', variant: 'warning' },
    approved: { label: 'Disetujui', variant: 'success' },
    rejected: { label: 'Ditolak', variant: 'danger' },
    cancelled: { label: 'Dibatalkan', variant: 'neutral' },
}
const REVIEW_FILTERS = [
    { value: 'pending', label: 'Menunggu' },
    { value: 'approved', label: 'Disetujui' },
    { value: 'rejected', label: 'Ditolak' },
]

const loaded = ref(false)
const types = ref([])
const mine = ref([])
const review = ref([])
const canReview = ref(false)
const pendingCount = ref(0)
const reviewFilter = ref('pending')

async function load() {
    try {
        const { data } = await api.get('/leave-requests', { params: { status: reviewFilter.value } })
        types.value = data.data.types
        mine.value = data.data.mine
        review.value = data.data.review
        canReview.value = data.data.can_review
        pendingCount.value = data.data.pending_count
        loaded.value = true
    } catch (err) {
        toast.error('Gagal memuat izin & cuti', err.response?.data?.message)
    }
}
watch(reviewFilter, load)

// ===== Ajukan =====
const formOpen = ref(false)
const submitting = ref(false)
const form = ref(null)
const today = dayjs().format('YYYY-MM-DD')

function openForm() {
    form.value = { type: 'izin', start_date: today, end_date: today, reason: '' }
    formOpen.value = true
}

const formDays = computed(() => {
    if (!form.value?.start_date || !form.value?.end_date) return 0
    return Math.max(0, dayjs(form.value.end_date).diff(dayjs(form.value.start_date), 'day') + 1)
})

async function submit() {
    submitting.value = true
    try {
        await api.post('/leave-requests', form.value)
        toast.success('Pengajuan terkirim', 'Pengelola site Anda akan menyetujui atau menolaknya.')
        formOpen.value = false
        load()
    } catch (err) {
        toast.error('Pengajuan belum terkirim', err.response?.data?.message)
    } finally {
        submitting.value = false
    }
}

// ===== Setujui / tolak =====
const reviewing = ref(null) // { request, status }
const reviewNote = ref('')
const savingReview = ref(false)

function startReview(request, status) {
    reviewing.value = { request, status }
    reviewNote.value = ''
}

async function saveReview() {
    const { request, status } = reviewing.value
    savingReview.value = true
    try {
        await api.post(`/leave-requests/${request.id}/review`, { status, note: reviewNote.value || undefined })
        toast.success(status === 'approved' ? 'Pengajuan disetujui' : 'Pengajuan ditolak', request.user_name)
        reviewing.value = null
        load()
        refreshWorkCounters()
    } catch (err) {
        toast.error('Belum tersimpan', err.response?.data?.message)
    } finally {
        savingReview.value = false
    }
}

const cancelTarget = ref(null)
const cancelling = ref(false)
async function cancelRequest() {
    cancelling.value = true
    try {
        await api.post(`/leave-requests/${cancelTarget.value.id}/cancel`)
        toast.success('Pengajuan dibatalkan')
        load()
    } catch (err) {
        toast.error('Belum dibatalkan', err.response?.data?.message)
    } finally {
        cancelling.value = false
        cancelTarget.value = null
    }
}

const canCancel = (request) => request.status === 'pending' || (request.status === 'approved' && request.start_date > today)

function period(request) {
    const start = dayjs(request.start_date)
    if (request.start_date === request.end_date) return start.format('ddd, D MMM YYYY')
    return `${start.format('D MMM')} – ${dayjs(request.end_date).format('D MMM YYYY')}`
}

onMounted(load)
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Kerja"
            title="Izin & cuti"
            subtitle="Ajukan izin, sakit, atau cuti. Hari yang disetujui tercatat di absensi sebagai izin, bukan tidak masuk."
        >
            <template #actions>
                <BaseButton @click="openForm">
                    <Plus class="size-4" />
                    Ajukan izin
                </BaseButton>
            </template>
        </PageHeader>

        <div class="grid gap-5 p-4 sm:p-8" :class="canReview && 'xl:grid-cols-2'">
            <BaseCard v-if="canReview" title="Perlu disetujui" :count="reviewFilter === 'pending' ? pendingCount : review.length" flush>
                <template #actions>
                    <div class="flex gap-1 rounded-lg bg-base-850 p-0.5" role="radiogroup" aria-label="Status">
                        <button
                            v-for="option in REVIEW_FILTERS"
                            :key="option.value"
                            type="button"
                            role="radio"
                            :aria-checked="reviewFilter === option.value"
                            class="rounded-md px-2.5 py-1 text-xs font-semibold"
                            :class="reviewFilter === option.value ? 'bg-base-900 text-base-50 shadow-(--shadow-card)' : 'text-base-400'"
                            @click="reviewFilter = option.value"
                        >
                            {{ option.label }}
                        </button>
                    </div>
                </template>
                <EmptyState
                    v-if="!review.length"
                    :icon="CalendarOff"
                    :title="reviewFilter === 'pending' ? 'Tidak ada pengajuan yang menunggu' : 'Belum ada pengajuan'"
                    description="Pengajuan staf di site yang Anda kelola muncul di sini."
                />
                <ul v-else class="divide-y divide-base-800">
                    <li v-for="request in review" :key="request.id" class="px-5 py-4">
                        <div class="flex flex-wrap items-start justify-between gap-3">
                            <div class="min-w-0">
                                <p class="font-semibold text-base-50">{{ request.user_name }}</p>
                                <p class="text-xs text-base-500">{{ request.site_name ?? '—' }}</p>
                            </div>
                            <BaseBadge :variant="STATUS[request.status].variant">{{ STATUS[request.status].label }}</BaseBadge>
                        </div>
                        <p class="mt-2 text-sm text-base-200">
                            <span class="font-semibold">{{ request.type_label }}</span> · {{ period(request) }}
                            <span class="text-base-500">({{ request.days }} hari)</span>
                        </p>
                        <p class="mt-1 text-sm text-pretty text-base-400">{{ request.reason }}</p>
                        <p v-if="request.reviewed_by_name" class="mt-1.5 text-xs text-base-500">
                            {{ request.status === 'approved' ? 'Disetujui' : 'Ditolak' }} oleh {{ request.reviewed_by_name }}
                            <template v-if="request.review_note"> · "{{ request.review_note }}"</template>
                        </p>
                        <div v-if="request.status === 'pending'" class="mt-3 flex gap-2">
                            <BaseButton size="sm" @click="startReview(request, 'approved')"><Check class="size-4" /> Setujui</BaseButton>
                            <BaseButton size="sm" variant="danger-outline" @click="startReview(request, 'rejected')"
                                ><X class="size-4" /> Tolak</BaseButton
                            >
                        </div>
                    </li>
                </ul>
            </BaseCard>

            <BaseCard title="Pengajuan saya" :count="mine.length" flush>
                <div v-if="!loaded" class="px-5 py-10 text-center text-sm text-base-500">Memuat…</div>
                <EmptyState
                    v-else-if="!mine.length"
                    :icon="CalendarOff"
                    title="Belum ada pengajuan"
                    description="Tekan Ajukan izin untuk mengajukan izin, sakit, atau cuti."
                />
                <ul v-else class="divide-y divide-base-800">
                    <li v-for="request in mine" :key="request.id" class="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                        <div class="min-w-0">
                            <p class="text-sm text-base-100">
                                <span class="font-semibold">{{ request.type_label }}</span> · {{ period(request) }}
                                <span class="text-base-500">({{ request.days }} hari)</span>
                            </p>
                            <p class="mt-1 text-sm text-pretty text-base-400">{{ request.reason }}</p>
                            <p v-if="request.reviewed_by_name" class="mt-1 text-xs text-base-500">
                                {{ STATUS[request.status].label }} oleh {{ request.reviewed_by_name }}
                                <template v-if="request.review_note"> · "{{ request.review_note }}"</template>
                            </p>
                        </div>
                        <div class="flex items-center gap-2">
                            <BaseBadge :variant="STATUS[request.status].variant">{{ STATUS[request.status].label }}</BaseBadge>
                            <BaseButton v-if="canCancel(request)" size="sm" variant="ghost" @click="cancelTarget = request"
                                >Batalkan</BaseButton
                            >
                        </div>
                    </li>
                </ul>
            </BaseCard>
        </div>

        <BaseDialog
            :open="formOpen"
            title="Ajukan izin"
            description="Pengelola site Anda mendapat pemberitahuan."
            @update:open="(v) => (formOpen = v)"
        >
            <form v-if="form" id="leave-form" class="space-y-4" @submit.prevent="submit">
                <fieldset>
                    <legend class="field-label">Jenis</legend>
                    <div class="grid grid-cols-3 gap-1 rounded-xl bg-base-850 p-1" role="radiogroup">
                        <button
                            v-for="type in types"
                            :key="type.value"
                            type="button"
                            role="radio"
                            :aria-checked="form.type === type.value"
                            class="rounded-lg px-3 py-2 text-sm font-semibold transition-colors"
                            :class="
                                form.type === type.value
                                    ? 'bg-base-900 text-base-50 shadow-(--shadow-card)'
                                    : 'text-base-400 hover:text-base-200'
                            "
                            @click="form.type = type.value"
                        >
                            {{ type.label }}
                        </button>
                    </div>
                </fieldset>
                <div class="grid grid-cols-2 gap-3">
                    <BaseInput v-model="form.start_date" type="date" label="Mulai" required />
                    <BaseInput v-model="form.end_date" type="date" label="Sampai" required :min="form.start_date" />
                </div>
                <p class="text-xs text-base-500">{{ formDays }} hari · sakit boleh diajukan menyusul sampai 7 hari.</p>
                <label class="block">
                    <span class="field-label">Alasan <span class="text-danger-400" aria-hidden="true">*</span></span>
                    <textarea
                        v-model="form.reason"
                        rows="3"
                        required
                        minlength="3"
                        maxlength="1000"
                        class="field-control"
                        placeholder="Contoh: Demam, ada surat dokter."
                    />
                </label>
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="formOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="leave-form" :loading="submitting">Kirim pengajuan</BaseButton>
            </template>
        </BaseDialog>

        <BaseDialog
            :open="!!reviewing"
            :title="reviewing?.status === 'approved' ? 'Setujui pengajuan?' : 'Tolak pengajuan?'"
            :description="reviewing ? `${reviewing.request.user_name} · ${reviewing.request.type_label} ${period(reviewing.request)}` : ''"
            size="sm"
            @update:open="(v) => !v && (reviewing = null)"
        >
            <label class="block">
                <span class="field-label">Catatan untuk staf (opsional)</span>
                <textarea v-model="reviewNote" rows="2" maxlength="500" class="field-control" />
            </label>
            <template #footer>
                <BaseButton variant="ghost" @click="reviewing = null">Batal</BaseButton>
                <BaseButton :variant="reviewing?.status === 'approved' ? 'primary' : 'danger'" :loading="savingReview" @click="saveReview">
                    {{ reviewing?.status === 'approved' ? 'Setujui' : 'Tolak' }}
                </BaseButton>
            </template>
        </BaseDialog>

        <ConfirmDialog
            :open="!!cancelTarget"
            title="Batalkan pengajuan ini?"
            description="Pengajuan tidak lagi dihitung di absensi."
            confirm-label="Batalkan pengajuan"
            :loading="cancelling"
            @confirm="cancelRequest"
            @update:open="(v) => !v && (cancelTarget = null)"
        />
    </div>
</template>
