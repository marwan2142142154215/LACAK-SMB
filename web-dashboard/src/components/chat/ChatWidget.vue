<script setup>
import { ChevronDown, ExternalLink, ImagePlus, Loader2, MessagesSquare, Reply, SendHorizontal, X } from '@lucide/vue'
import dayjs from 'dayjs'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import { useToast } from '@/composables/useToast'
import { CHAT_IMAGE_TYPES, prepareChatImage } from '@/lib/chatImage'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'

const MAX_LENGTH = 1000

const auth = useAuthStore()
const chat = useChatStore()
const toast = useToast()

const draft = ref('')
const sending = ref(false)
const loadingOlder = ref(false)
const scroller = ref(null)
const composer = ref(null)
const fileInput = ref(null)
// Gambar yang siap dikirim: { file, previewUrl }
const attachment = ref(null)
const preparingImage = ref(false)
const dragging = ref(false)
// Gambar yang sedang dibuka layar penuh
const viewing = ref(null)
// Pesan yang baru saja dilompati dari kutipan -- disorot sebentar.
const highlightedId = ref(null)

const activeSite = computed(() => chat.sites.find((site) => site.id === chat.activeSiteId) ?? null)
const canSend = computed(() => (draft.value.trim() || attachment.value) && !sending.value && !preparingImage.value && chat.connected)

// Pesan dikelompokkan per hari, dan pesan beruntun dari orang yang sama dalam
// 5 menit tidak mengulang nama -- supaya percakapan mudah dibaca sekilas.
const rows = computed(() => {
    const result = []
    let previous = null
    for (const message of chat.activeMessages) {
        const at = dayjs(message.created_at)
        if (!previous || !at.isSame(previous.at, 'day')) {
            result.push({ type: 'day', key: `day-${message.id}`, label: dayLabel(at) })
            previous = null
        }
        const continued = previous && previous.userId === message.user_id && at.diff(previous.at, 'minute') < 5
        result.push({ type: 'message', key: message.id, message, at, own: message.user_id === auth.user?.id, continued })
        previous = { userId: message.user_id, at }
    }
    return result
})

function dayLabel(at) {
    if (at.isSame(dayjs(), 'day')) return 'Hari ini'
    if (at.isSame(dayjs().subtract(1, 'day'), 'day')) return 'Kemarin'
    return at.format('dddd, D MMMM YYYY')
}

const typingText = computed(() => {
    const names = chat.activeTyping
    if (!names.length) return null
    return names.length === 1 ? `${names[0]} sedang mengetik…` : `${names.length} orang sedang mengetik…`
})

function isNearBottom() {
    const el = scroller.value
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120
}

async function scrollToBottom() {
    await nextTick()
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
}

// Pesan baru: ikut turun hanya kalau user memang sedang di bawah (tidak
// menyentak orang yang sedang membaca pesan lama).
watch(
    () => chat.activeMessages.at(-1)?.id,
    () => {
        if (isNearBottom()) scrollToBottom()
        if (chat.open) chat.markRead()
    },
)

watch(
    () => [chat.open, chat.activeSiteId],
    ([isOpen]) => {
        if (!isOpen) return
        chat.markRead()
        scrollToBottom()
        nextTick(() => composer.value?.focus())
    },
)

// Balasan & lampiran milik satu ruang -- pindah site = batal.
watch(
    () => chat.activeSiteId,
    () => {
        chat.cancelReply()
        clearAttachment()
    },
)

// ---- Lampiran gambar

async function attach(file) {
    if (!file) return
    if (!CHAT_IMAGE_TYPES.includes(file.type)) {
        toast.error('Bukan gambar', 'Hanya gambar JPG, PNG, WEBP, atau GIF yang bisa dikirim.')
        return
    }
    preparingImage.value = true
    try {
        const prepared = await prepareChatImage(file)
        clearAttachment()
        attachment.value = { file: prepared, previewUrl: URL.createObjectURL(prepared) }
        nextTick(() => composer.value?.focus())
    } catch (err) {
        toast.error('Gambar tidak bisa dikirim', err.message)
    } finally {
        preparingImage.value = false
    }
}

function clearAttachment() {
    if (attachment.value) URL.revokeObjectURL(attachment.value.previewUrl)
    attachment.value = null
    if (fileInput.value) fileInput.value.value = ''
}

function onFilePicked(event) {
    attach(event.target.files?.[0])
}

// Tempel gambar dari clipboard (mis. tangkapan layar) langsung ke kolom pesan.
function onPaste(event) {
    const file = [...(event.clipboardData?.files ?? [])].find((item) => item.type.startsWith('image/'))
    if (!file) return
    event.preventDefault()
    attach(file)
}

function onDrop(event) {
    dragging.value = false
    attach([...(event.dataTransfer?.files ?? [])].find((item) => item.type.startsWith('image/')))
}

onBeforeUnmount(clearAttachment)

// ---- Kirim

async function send() {
    if (!canSend.value) return
    const body = draft.value.trim()
    sending.value = true
    try {
        if (attachment.value) {
            await chat.sendImage(attachment.value.file, body)
            clearAttachment()
        } else {
            await chat.send(body)
        }
        draft.value = ''
        scrollToBottom()
    } catch (err) {
        toast.error('Pesan belum terkirim', err.message)
    } finally {
        sending.value = false
        nextTick(() => composer.value?.focus())
    }
}

function onKeydown(event) {
    // Enter = kirim, Shift+Enter = baris baru (kebiasaan aplikasi chat).
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        send()
    }
    if (event.key === 'Escape' && chat.replyTo) {
        event.stopPropagation()
        chat.cancelReply()
    }
}

// ---- Balas

function reply(message) {
    chat.startReply(message)
    nextTick(() => composer.value?.focus())
}

function excerpt(message) {
    if (message.body) return message.body.length > 90 ? `${message.body.slice(0, 90)}…` : message.body
    return message.image || message.has_image ? 'Gambar' : ''
}

/** Lompat ke pesan asal yang dikutip (kalau sudah termuat). */
async function jumpTo(messageId) {
    const target = scroller.value?.querySelector(`[data-message-id="${messageId}"]`)
    if (!target) {
        toast.info('Pesan asal ada di riwayat lama', 'Tekan "Muat pesan sebelumnya" untuk melihatnya.')
        return
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    highlightedId.value = messageId
    setTimeout(() => {
        if (highlightedId.value === messageId) highlightedId.value = null
    }, 1600)
}

// ---- Lain-lain

async function loadOlder() {
    const el = scroller.value
    const previousHeight = el?.scrollHeight ?? 0
    loadingOlder.value = true
    try {
        await chat.loadOlder()
        await nextTick()
        // Pertahankan posisi baca setelah pesan lama disisipkan di atas.
        if (el) el.scrollTop = el.scrollHeight - previousHeight
    } catch (err) {
        toast.error('Gagal memuat pesan lama', err.message)
    } finally {
        loadingOlder.value = false
    }
}

// Gambar baru selesai dimuat menambah tinggi daftar -- tetap di bawah kalau tadi di bawah.
function onImageLoad() {
    if (isNearBottom()) scrollToBottom()
}

function imageBoxStyle(image) {
    if (!image?.width || !image?.height) return { width: '14rem', aspectRatio: '4 / 3' }
    // Gambar tegak dibatasi tingginya, gambar lebar dibatasi lebarnya.
    const ratio = image.width / image.height
    const width = ratio >= 1 ? 15 : Math.max(8, 15 * ratio * 1.2)
    return { width: `${Math.min(width, 15)}rem`, aspectRatio: `${image.width} / ${image.height}` }
}

function initials(name) {
    return (name ?? '?')
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase())
        .join('')
}
</script>

<template>
    <div v-if="chat.sites.length">
        <!-- Panel chat -->
        <Transition
            enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
            enter-from-class="translate-y-3 opacity-0"
            leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
            leave-to-class="translate-y-3 opacity-0"
        >
            <section
                v-if="chat.open"
                role="dialog"
                aria-label="Chat staf"
                class="fixed right-5 bottom-24 z-40 flex h-[min(36rem,calc(100dvh-8rem))] w-[min(24rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-base-800 bg-base-900 shadow-(--shadow-raised) max-sm:inset-x-3 max-sm:top-16 max-sm:bottom-24 max-sm:h-auto max-sm:w-auto"
                @dragover.prevent="dragging = true"
                @dragleave.self="dragging = false"
                @drop.prevent="onDrop"
            >
                <header class="flex items-start gap-3 border-b border-base-800 px-4 py-3">
                    <div class="min-w-0 flex-1">
                        <h2 class="font-display text-base font-semibold text-base-50">Chat staf</h2>
                        <label v-if="chat.sites.length > 1" class="relative mt-1 block w-fit">
                            <span class="sr-only">Ruang chat site</span>
                            <select
                                v-model="chat.activeSiteId"
                                class="appearance-none rounded-md bg-transparent py-0.5 pr-6 text-xs font-medium text-base-300 hover:text-base-50 focus-visible:outline-2 focus-visible:outline-accent-400"
                            >
                                <option v-for="site in chat.sites" :key="site.id" :value="site.id">
                                    {{ site.name }}{{ chat.unreadCount(site.id) ? ` (${chat.unreadCount(site.id)} baru)` : '' }}
                                </option>
                            </select>
                            <ChevronDown class="pointer-events-none absolute top-1/2 right-1 size-3.5 -translate-y-1/2 text-base-500" />
                        </label>
                        <p v-else class="mt-0.5 text-xs text-base-400">{{ activeSite?.name }}</p>
                    </div>
                    <p
                        class="mt-1 flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tracking-[0.08em] text-base-400 uppercase"
                        :title="chat.activePresence.map((u) => u.name).join(', ')"
                    >
                        <span class="led" :class="chat.connected ? 'text-st-working' : 'text-base-500 led-off'" />
                        {{ chat.connected ? `${chat.activePresence.length} online` : 'Terputus' }}
                    </p>
                    <button
                        type="button"
                        class="-mt-0.5 -mr-1 flex size-8 shrink-0 items-center justify-center rounded-md text-base-400 hover:bg-base-850 hover:text-base-50 focus-visible:outline-2 focus-visible:outline-accent-400"
                        aria-label="Tutup chat"
                        @click="chat.open = false"
                    >
                        <X class="size-4" />
                    </button>
                </header>

                <div ref="scroller" class="relative flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
                    <div v-if="chat.hasMoreBySite[chat.activeSiteId]" class="mb-3 text-center">
                        <button
                            type="button"
                            class="inline-flex items-center gap-1.5 rounded-full border border-base-800 px-3 py-1 text-xs text-base-400 hover:border-base-600 hover:text-base-100"
                            :disabled="loadingOlder"
                            @click="loadOlder"
                        >
                            <Loader2 v-if="loadingOlder" class="size-3 animate-spin" />
                            Muat pesan sebelumnya
                        </button>
                    </div>

                    <div v-if="!chat.activeMessages.length" class="flex h-full flex-col items-center justify-center gap-2 text-center">
                        <span class="flex size-11 items-center justify-center rounded-xl bg-base-850 text-base-400">
                            <MessagesSquare class="size-5" />
                        </span>
                        <p class="text-sm font-medium text-base-100">Belum ada pesan</p>
                        <p class="max-w-56 text-xs text-pretty text-base-500">
                            Pesan di sini terlihat oleh semua staf {{ activeSite?.name ?? 'site ini' }} secara langsung.
                        </p>
                    </div>

                    <template v-for="row in rows" :key="row.key">
                        <p
                            v-if="row.type === 'day'"
                            class="my-3 text-center font-mono text-[10.5px] tracking-[0.12em] text-base-500 uppercase"
                        >
                            {{ row.label }}
                        </p>
                        <div
                            v-else
                            class="group flex gap-2 rounded-xl transition-colors duration-500"
                            :class="[
                                row.own ? 'flex-row-reverse' : '',
                                row.continued ? 'mt-0.5' : 'mt-3',
                                highlightedId === row.message.id && 'bg-accent-500/10',
                            ]"
                            :data-message-id="row.message.id"
                        >
                            <span
                                v-if="!row.own"
                                class="flex size-7 shrink-0 items-center justify-center rounded-full bg-base-800 font-mono text-[10px] font-medium text-copper-400"
                                :class="row.continued && 'invisible'"
                                aria-hidden="true"
                            >
                                {{ initials(row.message.user_name) }}
                            </span>
                            <div class="flex max-w-[80%] min-w-0 flex-col" :class="row.own ? 'items-end' : 'items-start'">
                                <p v-if="!row.continued && !row.own" class="mb-0.5 text-xs font-medium text-base-300">
                                    {{ row.message.user_name ?? 'Staf' }}
                                </p>
                                <div
                                    class="overflow-hidden rounded-2xl text-sm leading-snug"
                                    :class="
                                        row.own ? 'rounded-br-md bg-accent-500 text-base-950' : 'rounded-bl-md bg-base-850 text-base-100'
                                    "
                                >
                                    <!-- Kutipan pesan yang dibalas -->
                                    <button
                                        v-if="row.message.reply_to"
                                        type="button"
                                        class="mx-1.5 mt-1.5 block max-w-[calc(100%-0.75rem)] min-w-40 rounded-lg border-l-[3px] px-2.5 py-1.5 text-left text-xs"
                                        :class="
                                            row.own
                                                ? 'border-base-950/50 bg-base-950/10 hover:bg-base-950/15'
                                                : 'border-accent-400 bg-base-900/70 hover:bg-base-900'
                                        "
                                        :aria-label="`Lihat pesan asal dari ${row.message.reply_to.user_name ?? 'staf'}`"
                                        @click="jumpTo(row.message.reply_to.id)"
                                    >
                                        <span class="block font-semibold" :class="row.own ? 'text-base-950' : 'text-accent-400'">
                                            {{ row.message.reply_to.user_name ?? 'Staf' }}
                                        </span>
                                        <span class="line-clamp-2 opacity-80 [overflow-wrap:anywhere]">
                                            <ImagePlus v-if="!row.message.reply_to.body" class="mr-1 inline size-3 align-[-2px]" />
                                            {{ excerpt(row.message.reply_to) }}
                                        </span>
                                    </button>
                                    <!-- Gambar -->
                                    <button
                                        v-if="row.message.image"
                                        type="button"
                                        class="mx-1.5 mt-1.5 block overflow-hidden rounded-xl bg-base-950/20 focus-visible:outline-2 focus-visible:outline-accent-400"
                                        :class="!row.message.body && 'mb-1.5'"
                                        :style="imageBoxStyle(row.message.image)"
                                        aria-label="Buka gambar"
                                        @click="viewing = row.message"
                                    >
                                        <img
                                            :src="row.message.image.url"
                                            alt=""
                                            loading="lazy"
                                            class="size-full object-cover"
                                            @load="onImageLoad"
                                        />
                                    </button>
                                    <p v-if="row.message.body" class="px-3 py-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
                                        {{ row.message.body }}
                                    </p>
                                </div>
                                <div class="mt-0.5 flex items-center gap-2" :class="row.own && 'flex-row-reverse'">
                                    <time class="font-mono text-[10px] text-base-500 tabular-nums" :datetime="row.message.created_at">
                                        {{ row.at.format('HH:mm') }}
                                    </time>
                                    <button
                                        type="button"
                                        class="inline-flex items-center gap-1 rounded px-1 text-[11px] text-base-500 opacity-70 hover:text-base-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent-400 sm:opacity-0 sm:group-hover:opacity-100"
                                        :aria-label="`Balas pesan ${row.message.user_name ?? 'staf'}`"
                                        @click="reply(row.message)"
                                    >
                                        <Reply class="size-3" />
                                        Balas
                                    </button>
                                </div>
                            </div>
                        </div>
                    </template>
                </div>

                <!-- Area jatuhkan gambar -->
                <div
                    v-if="dragging"
                    class="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-accent-400 bg-base-900/90 text-accent-400"
                >
                    <ImagePlus class="size-7" />
                    <p class="text-sm font-medium">Lepaskan untuk mengirim gambar</p>
                </div>

                <p v-if="typingText" class="px-4 pb-1 text-xs text-base-500 italic">{{ typingText }}</p>
                <p v-if="chat.error && !chat.connected" class="mx-4 mb-2 rounded-md bg-danger-500/10 px-3 py-1.5 text-xs text-danger-400">
                    {{ chat.error }}
                </p>

                <form class="border-t border-base-800 p-3" @submit.prevent="send">
                    <!-- Sedang membalas -->
                    <div
                        v-if="chat.replyTo"
                        class="mb-2 flex items-start gap-2 rounded-lg border-l-[3px] border-accent-400 bg-base-850 py-1.5 pr-1 pl-2.5"
                    >
                        <Reply class="mt-0.5 size-3.5 shrink-0 text-accent-400" />
                        <div class="min-w-0 flex-1 text-xs">
                            <p class="font-semibold text-accent-400">Membalas {{ chat.replyTo.user_name ?? 'staf' }}</p>
                            <p class="truncate text-base-400">{{ excerpt(chat.replyTo) }}</p>
                        </div>
                        <button
                            type="button"
                            class="flex size-6 shrink-0 items-center justify-center rounded text-base-500 hover:bg-base-800 hover:text-base-100"
                            aria-label="Batal membalas"
                            @click="chat.cancelReply()"
                        >
                            <X class="size-3.5" />
                        </button>
                    </div>

                    <!-- Gambar yang akan dikirim -->
                    <div v-if="attachment || preparingImage" class="mb-2 flex items-center gap-3 rounded-lg bg-base-850 p-1.5 pr-1">
                        <div class="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-base-800">
                            <Loader2 v-if="preparingImage" class="size-4 animate-spin text-base-400" />
                            <img v-else :src="attachment.previewUrl" alt="Pratinjau gambar" class="size-full object-cover" />
                        </div>
                        <p class="min-w-0 flex-1 text-xs text-base-400">
                            <template v-if="preparingImage">Menyiapkan gambar…</template>
                            <template v-else>
                                <span class="block truncate font-medium text-base-100">{{ attachment.file.name }}</span>
                                {{ Math.max(1, Math.round(attachment.file.size / 1024)) }} KB · tambahkan keterangan bila perlu
                            </template>
                        </p>
                        <button
                            v-if="attachment"
                            type="button"
                            class="flex size-7 shrink-0 items-center justify-center rounded text-base-500 hover:bg-base-800 hover:text-base-100"
                            aria-label="Batalkan gambar"
                            @click="clearAttachment"
                        >
                            <X class="size-4" />
                        </button>
                    </div>

                    <div class="flex items-end gap-2">
                        <input
                            ref="fileInput"
                            type="file"
                            :accept="CHAT_IMAGE_TYPES.join(',')"
                            class="sr-only"
                            tabindex="-1"
                            @change="onFilePicked"
                        />
                        <button
                            type="button"
                            class="flex size-10 shrink-0 items-center justify-center rounded-lg text-base-400 hover:bg-base-850 hover:text-base-100 focus-visible:outline-2 focus-visible:outline-accent-400 disabled:opacity-40"
                            aria-label="Lampirkan gambar"
                            title="Lampirkan gambar (atau tempel / seret ke sini)"
                            :disabled="preparingImage || sending"
                            @click="fileInput?.click()"
                        >
                            <ImagePlus class="size-5" />
                        </button>
                        <label class="min-w-0 flex-1">
                            <span class="sr-only">Pesan</span>
                            <textarea
                                ref="composer"
                                v-model="draft"
                                rows="1"
                                :maxlength="MAX_LENGTH"
                                :placeholder="attachment ? 'Keterangan gambar (opsional)…' : 'Tulis pesan…'"
                                class="field-control max-h-32 min-h-10 resize-none [field-sizing:content]"
                                @keydown="onKeydown"
                                @input="chat.notifyTyping()"
                                @paste="onPaste"
                            />
                            <span v-if="draft.length > MAX_LENGTH - 100" class="mt-1 block text-right font-mono text-[10px] text-base-500">
                                {{ draft.length }}/{{ MAX_LENGTH }}
                            </span>
                        </label>
                        <button
                            type="submit"
                            class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-500 text-base-950 transition-colors hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400 disabled:cursor-not-allowed disabled:opacity-40"
                            :disabled="!canSend"
                            aria-label="Kirim pesan"
                        >
                            <Loader2 v-if="sending" class="size-4 animate-spin" />
                            <SendHorizontal v-else class="size-4" />
                        </button>
                    </div>
                </form>
            </section>
        </Transition>

        <!-- Gambar layar penuh -->
        <DialogRoot :open="!!viewing" @update:open="(value) => !value && (viewing = null)">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm" />
                <DialogContent
                    class="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 p-4 focus:outline-none sm:p-10"
                    @click.self="viewing = null"
                >
                    <DialogTitle class="sr-only">Gambar dari {{ viewing?.user_name ?? 'staf' }}</DialogTitle>
                    <img
                        v-if="viewing"
                        :src="viewing.image.url"
                        :alt="viewing.body ?? `Gambar dari ${viewing.user_name ?? 'staf'}`"
                        class="max-h-[80dvh] max-w-full rounded-lg object-contain shadow-2xl"
                    />
                    <div v-if="viewing" class="flex max-w-2xl flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm text-white/85">
                        <span>
                            <strong class="font-semibold text-white">{{ viewing.user_name ?? 'Staf' }}</strong>
                            · {{ dayjs(viewing.created_at).format('D MMM YYYY, HH:mm') }}
                        </span>
                        <a
                            :href="viewing.image.url"
                            target="_blank"
                            rel="noopener"
                            class="inline-flex items-center gap-1 text-white/70 underline-offset-2 hover:text-white hover:underline"
                        >
                            <ExternalLink class="size-3.5" />
                            Buka ukuran asli
                        </a>
                    </div>
                    <p v-if="viewing?.body" class="max-w-2xl text-center text-sm text-pretty whitespace-pre-wrap text-white/80">
                        {{ viewing.body }}
                    </p>
                    <button
                        type="button"
                        class="absolute top-4 right-4 flex size-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-white"
                        aria-label="Tutup gambar"
                        @click="viewing = null"
                    >
                        <X class="size-5" />
                    </button>
                </DialogContent>
            </DialogPortal>
        </DialogRoot>

        <!-- Tombol mengambang -->
        <button
            type="button"
            class="fixed right-5 bottom-5 z-40 flex size-14 items-center justify-center rounded-full bg-accent-500 text-base-950 shadow-(--shadow-raised) transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400 motion-reduce:transition-none motion-reduce:hover:scale-100"
            :aria-label="chat.open ? 'Tutup chat staf' : `Buka chat staf${chat.totalUnread ? ` (${chat.totalUnread} belum dibaca)` : ''}`"
            :aria-expanded="chat.open"
            @click="chat.open = !chat.open"
        >
            <X v-if="chat.open" class="size-6" />
            <MessagesSquare v-else class="size-6" />
            <span
                v-if="!chat.open && chat.totalUnread"
                class="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-danger-500 px-1 font-mono text-[11px] font-semibold text-white ring-2 ring-base-950 tabular-nums"
            >
                {{ chat.totalUnread > 99 ? '99+' : chat.totalUnread }}
            </span>
        </button>
    </div>
</template>
