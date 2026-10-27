<script setup>
import { ChevronDown, Maximize2, MessagesSquare, X } from '@lucide/vue'
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'

import ChatThread from '@/components/chat/ChatThread.vue'
import { useChatStore } from '@/stores/chat'

const chat = useChatStore()
const route = useRoute()

const activeSite = computed(() => chat.sites.find((site) => site.id === chat.activeSiteId) ?? null)
// Halaman Chat sudah menampilkan semua percakapan -- tombol mengambang disembunyikan di sana.
const onChatPage = computed(() => route.name === 'chat')

const siteThread = computed(() => ({
    key: `site:${chat.activeSiteId}`,
    messages: chat.activeMessages,
    hasMore: !!chat.hasMoreBySite[chat.activeSiteId],
    typing: chat.activeTyping,
    connected: chat.connected,
    error: chat.error,
    replyTo: chat.replyTo,
    emptyText: `Pesan di sini terlihat oleh semua staf ${activeSite.value?.name ?? 'site ini'} secara langsung.`,
    send: chat.send,
    sendImage: chat.sendImage,
    loadOlder: chat.loadOlder,
    startReply: chat.startReply,
    cancelReply: chat.cancelReply,
    notifyTyping: chat.notifyTyping,
    markRead: () => chat.markRead(),
}))

// Balasan milik satu ruang -- pindah site = batal.
watch(
    () => chat.activeSiteId,
    () => chat.cancelReply(),
)
watch(onChatPage, (value) => value && (chat.open = false))
</script>

<template>
    <div v-if="chat.sites.length && !onChatPage">
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
                        <h2 class="font-display text-base font-bold tracking-[-0.015em] text-base-50">Chat staf</h2>
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
                        class="mt-1 flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-base-400"
                        :title="chat.activePresence.map((u) => u.name).join(', ')"
                    >
                        <span class="led" :class="chat.connected ? 'text-st-working' : 'text-base-500 led-off'" />
                        {{ chat.connected ? `${chat.activePresence.length} online` : 'Terputus' }}
                    </p>
                    <router-link
                        :to="{ name: 'chat' }"
                        class="-mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md text-base-400 hover:bg-base-850 hover:text-base-50 focus-visible:outline-2 focus-visible:outline-accent-400"
                        aria-label="Buka halaman Chat (grup & semua percakapan)"
                        title="Buka halaman Chat"
                    >
                        <Maximize2 class="size-4" />
                    </router-link>
                    <button
                        type="button"
                        class="-mt-0.5 -mr-1 flex size-8 shrink-0 items-center justify-center rounded-md text-base-400 hover:bg-base-850 hover:text-base-50 focus-visible:outline-2 focus-visible:outline-accent-400"
                        aria-label="Tutup chat"
                        @click="chat.open = false"
                    >
                        <X class="size-4" />
                    </button>
                </header>

                <ChatThread :thread="siteThread" :active="chat.open" />
            </section>
        </Transition>

        <!-- Tombol mengambang -->
        <button
            type="button"
            class="fixed right-5 bottom-5 z-40 flex size-14 items-center justify-center rounded-full bg-accent-500 text-base-950 shadow-(--shadow-raised) transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400 motion-reduce:transition-none motion-reduce:hover:scale-100"
            :aria-label="chat.open ? 'Tutup chat staf' : `Buka chat staf${chat.siteUnread ? ` (${chat.siteUnread} belum dibaca)` : ''}`"
            :aria-expanded="chat.open"
            @click="chat.open = !chat.open"
        >
            <X v-if="chat.open" class="size-6" />
            <MessagesSquare v-else class="size-6" />
            <span
                v-if="!chat.open && chat.siteUnread"
                class="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-danger-500 px-1 font-mono text-[11px] font-semibold text-white tabular-nums ring-2 ring-base-950"
            >
                {{ chat.siteUnread > 99 ? '99+' : chat.siteUnread }}
            </span>
        </button>
    </div>
</template>
