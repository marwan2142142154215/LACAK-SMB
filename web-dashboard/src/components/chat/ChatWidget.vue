<script setup>
import { ChevronDown, Loader2, MessagesSquare, SendHorizontal, X } from '@lucide/vue'
import dayjs from 'dayjs'
import { computed, nextTick, ref, watch } from 'vue'

import { useToast } from '@/composables/useToast'
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

const activeSite = computed(() => chat.sites.find((site) => site.id === chat.activeSiteId) ?? null)

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

async function send() {
    const body = draft.value.trim()
    if (!body || sending.value) return
    sending.value = true
    try {
        await chat.send(body)
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
}

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

                <div ref="scroller" class="flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
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
                        <div v-else class="flex gap-2" :class="[row.own ? 'flex-row-reverse' : '', row.continued ? 'mt-0.5' : 'mt-3']">
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
                                <p
                                    class="rounded-2xl px-3 py-2 text-sm leading-snug whitespace-pre-wrap [overflow-wrap:anywhere]"
                                    :class="
                                        row.own ? 'rounded-br-md bg-accent-500 text-base-950' : 'rounded-bl-md bg-base-850 text-base-100'
                                    "
                                >
                                    {{ row.message.body }}
                                </p>
                                <time class="mt-0.5 font-mono text-[10px] text-base-500 tabular-nums" :datetime="row.message.created_at">
                                    {{ row.at.format('HH:mm') }}
                                </time>
                            </div>
                        </div>
                    </template>
                </div>

                <p v-if="typingText" class="px-4 pb-1 text-xs text-base-500 italic">{{ typingText }}</p>
                <p v-if="chat.error && !chat.connected" class="mx-4 mb-2 rounded-md bg-danger-500/10 px-3 py-1.5 text-xs text-danger-400">
                    {{ chat.error }}
                </p>

                <form class="flex items-end gap-2 border-t border-base-800 p-3" @submit.prevent="send">
                    <label class="min-w-0 flex-1">
                        <span class="sr-only">Pesan</span>
                        <textarea
                            ref="composer"
                            v-model="draft"
                            rows="1"
                            :maxlength="MAX_LENGTH"
                            placeholder="Tulis pesan…"
                            class="field-control max-h-32 min-h-10 resize-none [field-sizing:content]"
                            @keydown="onKeydown"
                            @input="chat.notifyTyping()"
                        />
                        <span v-if="draft.length > MAX_LENGTH - 100" class="mt-1 block text-right font-mono text-[10px] text-base-500">
                            {{ draft.length }}/{{ MAX_LENGTH }}
                        </span>
                    </label>
                    <button
                        type="submit"
                        class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-500 text-base-950 transition-colors hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400 disabled:cursor-not-allowed disabled:opacity-40"
                        :disabled="!draft.trim() || sending || !chat.connected"
                        aria-label="Kirim pesan"
                    >
                        <Loader2 v-if="sending" class="size-4 animate-spin" />
                        <SendHorizontal v-else class="size-4" />
                    </button>
                </form>
            </section>
        </Transition>

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
