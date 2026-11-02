<script setup>
import { Lock, Pencil, Plus, ShieldCheck, Trash2 } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'

const toast = useToast()

const roles = ref([])
const permissions = ref([])
const loading = ref(true)

const dialogOpen = ref(false)
const submitting = ref(false)
const editTarget = ref(null)
const deleteTarget = ref(null)
const deleting = ref(false)

const SCOPE_LABELS = {
    all: 'Semua site',
    granted: 'Site yang diberikan',
    own: 'Site sendiri',
}
const SCOPE_HINTS = {
    all: 'Melihat dan mengelola semua site.',
    granted: 'Hanya site yang diberikan lewat menu Staf (akses site per staf).',
    own: 'Hanya site tempat staf itu terdaftar.',
}

// watch_all = boleh menonton siaran Live Kerja semua peran; kalau tidak, hanya watchable_roles.
const emptyForm = () => ({
    name: '',
    label: '',
    description: '',
    site_scope: 'own',
    level: 100,
    permissions: [],
    watch_all: true,
    watchable_roles: [],
})
const form = ref(emptyForm())

// Peran yang bisa dipilih sebagai "boleh ditonton" (akun layanan bot tidak pernah siaran).
const watchableOptions = computed(() => roles.value.filter((role) => role.name !== 'telegram_bot_service'))

function toggleWatchable(name, checked) {
    const current = form.value.watchable_roles
    form.value.watchable_roles = checked ? [...new Set([...current, name])] : current.filter((item) => item !== name)
}

/** Ringkasan hak tonton di kartu peran. */
function watchSummary(role) {
    if (!role.watchable_roles) return 'Semua peran'
    if (!role.watchable_roles.length) return 'Tidak ada'
    const labels = Object.fromEntries(roles.value.map((item) => [item.name, item.label]))
    return role.watchable_roles.map((name) => labels[name] ?? name).join(', ')
}

// Peran dikunci (super_admin, akun layanan bot) hanya bisa dilihat. Cakupan peran bawaan tetap.
const isLocked = computed(() => editTarget.value?.locked ?? false)
const scopeFixed = computed(() => isLocked.value || (editTarget.value?.is_system ?? false))

// Izin dikelompokkan untuk matriks, urutan kelompok mengikuti server.
const groupedPermissions = computed(() => {
    const groups = []
    for (const permission of permissions.value) {
        let group = groups.find((item) => item.name === permission.group)
        if (!group) groups.push((group = { name: permission.group, items: [] }))
        group.items.push(permission)
    }
    return groups
})

async function loadRoles() {
    try {
        const response = await api.get('/roles')
        roles.value = response.data.data.roles
        permissions.value = response.data.data.permissions
    } catch (err) {
        toast.error('Gagal memuat daftar peran', err.response?.data?.message)
    } finally {
        loading.value = false
    }
}

function openCreate() {
    editTarget.value = null
    form.value = emptyForm()
    dialogOpen.value = true
}

function openEdit(role) {
    editTarget.value = role
    form.value = {
        name: role.name,
        label: role.label,
        description: role.description ?? '',
        site_scope: role.site_scope,
        level: role.level ?? 100,
        permissions: [...role.permissions],
        watch_all: role.watchable_roles === null || role.watchable_roles === undefined,
        watchable_roles: [...(role.watchable_roles ?? [])],
    }
    dialogOpen.value = true
}

function togglePermission(name, checked) {
    const current = form.value.permissions
    form.value.permissions = checked ? [...new Set([...current, name])] : current.filter((item) => item !== name)
}

// Izin pengelolaan akses (sensitif) hanya milik Super Admin: tidak bisa diberikan ke peran lain.
const isSensitiveLocked = (permission) =>
    permission.sensitive && !(editTarget.value?.permissions ?? []).includes(permission.name)

function toggleGroup(group, checked) {
    const names = group.items.filter((item) => !isSensitiveLocked(item)).map((item) => item.name)
    const rest = form.value.permissions.filter((item) => !names.includes(item))
    form.value.permissions = checked ? [...rest, ...names] : rest
}

const groupFullyChecked = (group) => group.items.every((item) => form.value.permissions.includes(item.name))

function errorDetail(err) {
    const errors = err.response?.data?.errors
    return errors ? Object.values(errors).flat().join(' ') : err.response?.data?.message
}

async function submitForm() {
    if (isLocked.value) return
    submitting.value = true
    try {
        const payload = {
            label: form.value.label,
            description: form.value.description || null,
            site_scope: form.value.site_scope,
            level: Number(form.value.level),
            permissions: form.value.permissions,
            // null = boleh menonton siaran semua peran.
            watchable_roles: form.value.watch_all ? null : form.value.watchable_roles,
        }
        if (editTarget.value) {
            await api.put(`/roles/${editTarget.value.id}`, payload)
            toast.success('Peran diperbarui')
        } else {
            await api.post('/roles', { ...payload, name: form.value.name })
            toast.success('Peran dibuat')
        }
        dialogOpen.value = false
        await loadRoles()
    } catch (err) {
        toast.error(editTarget.value ? 'Gagal memperbarui peran' : 'Gagal membuat peran', errorDetail(err))
    } finally {
        submitting.value = false
    }
}

async function confirmDelete() {
    deleting.value = true
    try {
        await api.delete(`/roles/${deleteTarget.value.id}`)
        toast.success('Peran dihapus')
        deleteTarget.value = null
        await loadRoles()
    } catch (err) {
        toast.error('Gagal menghapus peran', errorDetail(err))
    } finally {
        deleting.value = false
    }
}

const canDelete = (role) => !role.is_system && !role.locked

onMounted(loadRoles)
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Akses"
            title="Peran"
            subtitle="Buat peran baru dan atur izin serta cakupan site-nya. Perubahan langsung berlaku di permintaan staf berikutnya, tanpa login ulang."
        >
            <template #actions>
                <BaseButton @click="openCreate"><Plus class="size-4" /> Buat peran</BaseButton>
            </template>
            <template v-if="!loading" #readouts>
                <Readout label="Peran" :value="roles.length" />
                <Readout label="Buatan sendiri" :value="roles.filter((role) => !role.is_system).length" led="accent" />
            </template>
        </PageHeader>

        <div v-if="loading" class="px-5 py-12 text-center text-sm text-base-500">Memuat peran…</div>
        <div v-else-if="roles.length === 0" class="rounded-xl border border-base-800 bg-base-900/70">
            <EmptyState :icon="ShieldCheck" title="Belum ada peran" description="Buat peran pertama." />
        </div>
        <div v-else class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <article
                v-for="role in roles"
                :key="role.id"
                class="flex flex-col gap-3 rounded-xl border border-base-800 bg-base-900/70 p-4"
            >
                <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                        <h3 class="truncate text-base font-semibold text-base-50">{{ role.label }}</h3>
                        <p class="truncate font-mono text-xs text-base-500">{{ role.name }}</p>
                    </div>
                    <div class="flex shrink-0 items-center gap-1.5">
                        <BaseBadge v-if="role.locked" variant="warning"><Lock class="mr-1 size-3" /> Dikunci</BaseBadge>
                        <BaseBadge v-else-if="role.is_system">Bawaan</BaseBadge>
                        <BaseBadge v-else variant="accent">Buatan sendiri</BaseBadge>
                    </div>
                </div>
                <p v-if="role.description" class="text-sm text-base-300">{{ role.description }}</p>
                <dl class="grid grid-cols-4 gap-2 text-xs">
                    <div>
                        <dt class="text-base-500">Level</dt>
                        <dd class="text-base-100">{{ role.level }}</dd>
                    </div>
                    <div>
                        <dt class="text-base-500">Cakupan</dt>
                        <dd class="text-base-100">{{ SCOPE_LABELS[role.site_scope] }}</dd>
                    </div>
                    <div>
                        <dt class="text-base-500">Izin</dt>
                        <dd class="text-base-100">{{ role.permissions.length }}</dd>
                    </div>
                    <div>
                        <dt class="text-base-500">Staf</dt>
                        <dd class="text-base-100">{{ role.users_count }}</dd>
                    </div>
                </dl>
                <p class="text-xs text-base-500">
                    Tonton Live: <span class="text-base-200">{{ watchSummary(role) }}</span>
                </p>
                <div class="mt-auto flex items-center gap-2 pt-1">
                    <BaseButton variant="outline" size="sm" @click="openEdit(role)">
                        <Pencil class="size-3.5" /> {{ role.locked ? 'Lihat' : 'Atur' }}
                    </BaseButton>
                    <BaseButton v-if="canDelete(role)" variant="ghost" size="sm" @click="deleteTarget = role">
                        <Trash2 class="size-3.5" /> Hapus
                    </BaseButton>
                </div>
            </article>
        </div>

        <BaseDialog
            :open="dialogOpen"
            :title="editTarget ? (isLocked ? `Peran ${editTarget.label}` : `Atur peran ${editTarget.label}`) : 'Buat peran'"
            :description="
                isLocked
                    ? 'Peran ini dikunci: tidak bisa diubah atau dihapus supaya akses penuh sistem tidak hilang.'
                    : 'Centang izin yang boleh dilakukan peran ini, lalu pilih cakupan site-nya.'
            "
            size="lg"
            @update:open="(v) => (dialogOpen = v)"
        >
            <form id="role-form" class="space-y-4" @submit.prevent="submitForm">
                <BaseInput
                    v-if="!editTarget"
                    v-model="form.name"
                    label="Kode peran"
                    required
                    maxlength="40"
                    hint="Huruf kecil, angka, dan garis bawah (mis. audit_site). Tidak bisa diganti setelah dibuat."
                />
                <BaseInput v-model="form.label" label="Nama peran" required maxlength="100" :disabled="isLocked" />
                <BaseInput v-model="form.description" label="Deskripsi" maxlength="255" :disabled="isLocked" />

                <BaseInput
                    v-model="form.level"
                    type="number"
                    label="Level (0-100)"
                    required
                    min="0"
                    max="100"
                    step="1"
                    inputmode="numeric"
                    hint="0 = root (melihat semua). Peran hanya melihat peran dengan level LEBIH BESAR dari levelnya; level yang sama tidak saling melihat, dan 100 hanya melihat dirinya sendiri. Tetap dibatasi site yang diberikan."
                    :disabled="isLocked"
                />

                <BaseSelect
                    v-model="form.site_scope"
                    label="Cakupan site"
                    :hint="
                        scopeFixed && !isLocked
                            ? 'Cakupan peran bawaan tetap. ' + SCOPE_HINTS[form.site_scope]
                            : SCOPE_HINTS[form.site_scope]
                    "
                    :disabled="scopeFixed"
                >
                    <option v-for="(label, scope) in SCOPE_LABELS" :key="scope" :value="scope">{{ label }}</option>
                </BaseSelect>

                <fieldset class="space-y-3" :disabled="isLocked">
                    <legend class="field-label">Izin ({{ form.permissions.length }} dipilih)</legend>
                    <div
                        v-for="group in groupedPermissions"
                        :key="group.name"
                        class="rounded-lg border border-base-800 bg-base-900/60"
                    >
                        <label class="flex items-center gap-2 border-b border-base-800 px-3 py-2 text-xs font-semibold tracking-wide text-base-300 uppercase">
                            <input
                                type="checkbox"
                                class="size-4 accent-copper-500"
                                :checked="groupFullyChecked(group)"
                                :disabled="isLocked"
                                @change="toggleGroup(group, $event.target.checked)"
                            />
                            {{ group.name }}
                        </label>
                        <ul class="divide-y divide-base-800/70">
                            <li v-for="permission in group.items" :key="permission.name">
                                <label class="flex cursor-pointer items-start gap-2.5 px-3 py-2">
                                    <input
                                        type="checkbox"
                                        class="mt-0.5 size-4 accent-copper-500"
                                        :checked="form.permissions.includes(permission.name)"
                                        :disabled="isLocked || isSensitiveLocked(permission)"
                                        @change="togglePermission(permission.name, $event.target.checked)"
                                    />
                                    <span class="min-w-0">
                                        <span class="flex items-center gap-1.5 text-sm text-base-100">
                                            {{ permission.label }}
                                            <BaseBadge v-if="permission.sensitive" variant="warning">Hanya Super Admin</BaseBadge>
                                        </span>
                                        <span class="block text-xs text-base-500">{{ permission.description }}</span>
                                    </span>
                                </label>
                            </li>
                        </ul>
                    </div>
                </fieldset>

                <!-- Hak tonton Live Kerja per peran: siaran peran mana saja yang boleh ditonton peran ini. -->
                <fieldset class="space-y-2" :disabled="isLocked">
                    <legend class="field-label">Boleh menonton siaran Live dari</legend>
                    <p class="text-xs text-base-500">
                        Berlaku untuk video, status, dan rekaman Live Kerja. Tetap butuh izin "Pantau Live Kerja" & "Lihat rekan
                        se-site", dan hanya di site dalam cakupannya.
                    </p>
                    <div class="flex flex-wrap gap-4 text-sm text-base-100">
                        <label class="flex cursor-pointer items-center gap-2">
                            <input v-model="form.watch_all" type="radio" :value="true" class="size-4 accent-copper-500" />
                            Semua peran
                        </label>
                        <label class="flex cursor-pointer items-center gap-2">
                            <input v-model="form.watch_all" type="radio" :value="false" class="size-4 accent-copper-500" />
                            Peran tertentu
                        </label>
                    </div>
                    <ul v-if="!form.watch_all" class="grid gap-1 rounded-lg border border-base-800 bg-base-900/60 p-2 sm:grid-cols-2">
                        <li v-for="option in watchableOptions" :key="option.name">
                            <label class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-base-100 hover:bg-base-850">
                                <input
                                    type="checkbox"
                                    class="size-4 accent-copper-500"
                                    :checked="form.watchable_roles.includes(option.name)"
                                    @change="toggleWatchable(option.name, $event.target.checked)"
                                />
                                {{ option.label }}
                            </label>
                        </li>
                    </ul>
                    <p v-if="!form.watch_all && !form.watchable_roles.length" class="text-xs text-warning-400">
                        Belum ada peran dipilih: peran ini tidak akan bisa menonton siaran siapa pun.
                    </p>
                </fieldset>
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="dialogOpen = false">{{ isLocked ? 'Tutup' : 'Batal' }}</BaseButton>
                <BaseButton v-if="!isLocked" type="submit" form="role-form" :loading="submitting">{{
                    editTarget ? 'Simpan perubahan' : 'Buat peran'
                }}</BaseButton>
            </template>
        </BaseDialog>

        <ConfirmDialog
            :open="!!deleteTarget"
            :title="deleteTarget ? `Hapus peran ${deleteTarget.label}?` : ''"
            description="Peran dihapus permanen. Peran yang masih dipakai staf tidak bisa dihapus."
            confirm-label="Hapus peran"
            :loading="deleting"
            @update:open="(v) => !v && (deleteTarget = null)"
            @confirm="confirmDelete"
        />
    </div>
</template>
