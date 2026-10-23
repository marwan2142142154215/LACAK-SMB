<script setup>
import { MoreHorizontal } from '@lucide/vue'
import {
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuPortal,
    DropdownMenuRoot,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from 'reka-ui'

defineProps({
    /**
     * Aksi sekunder satu baris. Item ber-`danger` selalu dipisah garis di
     * bawah supaya tindakan merusak tidak bersebelahan dengan yang aman.
     * @type {{ label: string, icon?: object, onSelect: Function, danger?: boolean, disabled?: boolean, hidden?: boolean }[]}
     */
    items: { type: Array, required: true },
    label: { type: String, default: 'Aksi lainnya' },
})
</script>

<template>
    <DropdownMenuRoot :modal="false">
        <DropdownMenuTrigger
            :aria-label="label"
            class="flex size-8 items-center justify-center rounded-lg text-base-400 transition-colors hover:bg-base-800 hover:text-base-50 focus-visible:outline-2 focus-visible:outline-accent-400 data-[state=open]:bg-base-800 data-[state=open]:text-base-50"
        >
            <MoreHorizontal class="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
            <DropdownMenuContent
                align="end"
                :side-offset="6"
                class="menu-content z-50 min-w-48 rounded-lg border border-base-700 bg-base-850 p-1 shadow-xl shadow-black/50"
            >
                <template v-for="(item, index) in items.filter((i) => !i.hidden)" :key="item.label">
                    <DropdownMenuSeparator v-if="item.danger && index > 0" class="my-1 h-px bg-base-700" />
                    <DropdownMenuItem
                        :disabled="item.disabled"
                        class="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40"
                        :class="
                            item.danger
                                ? 'text-danger-400 data-[highlighted]:bg-danger-500/10'
                                : 'text-base-200 data-[highlighted]:bg-base-800 data-[highlighted]:text-base-50'
                        "
                        @select="item.onSelect"
                    >
                        <component :is="item.icon" v-if="item.icon" class="size-4 shrink-0 opacity-80" />
                        {{ item.label }}
                    </DropdownMenuItem>
                </template>
            </DropdownMenuContent>
        </DropdownMenuPortal>
    </DropdownMenuRoot>
</template>

<style scoped>
.menu-content[data-state='open'] {
    animation: menu-in 120ms ease-out;
}

@keyframes menu-in {
    from {
        opacity: 0;
        transform: translateY(-4px);
    }
}

@media (prefers-reduced-motion: reduce) {
    .menu-content[data-state='open'] {
        animation: none;
    }
}
</style>
