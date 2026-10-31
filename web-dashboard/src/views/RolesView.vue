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

const emptyForm = () => ({ name: '', label: '', description: '', site_scope: 'own', permissions: [] })
const form = ref(emptyForm())

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
        permissions: [...role.permissions],
    }
    dialogOpen.value = true
}

function togglePermission(name, checked) {
    const current = form.value.permissions
    form.value.permissions = checked ? [...new Set([...current, name])] : current.filter((item) => item !== name)
}

function toggleGroup(group, checked) {
    const names = group.items.map((item) => item.name)
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
            permissions: form.value.permissions,
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
                <dl class="grid grid-cols-3 gap-2 text-xs">
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
                                        :disabled="isLocked"
                                        @change="togglePermission(permission.name, $event.target.checked)"
                                    />
                                    <span class="min-w-0">
                                        <span class="flex items-center gap-1.5 text-sm text-base-100">
                                            {{ permission.label }}
                                            <BaseBadge v-if="permission.sensitive" variant="warning">Sensitif</BaseBadge>
                                        </span>
                                        <span class="block text-xs text-base-500">{{ permission.description }}</span>
                                    </span>
                                </label>
                            </li>
                        </ul>
                    </div>
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
