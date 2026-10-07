import { reactive } from 'vue'

/**
 * Composable bersama untuk toast (standar 1.4: dibungkus satu composable
 * agar mudah dipanggil dari mana saja). Dipakai lewat <ToastViewport /> di
 * App.vue, yang me-render primitif Reka UI (ToastRoot/ToastTitle/dst).
 */
const toasts = reactive([])
let nextId = 1

function push(variant, title, description) {
    const id = nextId++
    toasts.push({ id, variant, title, description, open: true })

    setTimeout(() => dismiss(id), 5000)

    return id
}

function dismiss(id) {
    const index = toasts.findIndex((t) => t.id === id)
    if (index !== -1) toasts.splice(index, 1)
}

export function useToast() {
    return {
        toasts,
        success: (title, description) => push('success', title, description),
        error: (title, description) => push('error', title, description),
        info: (title, description) => push('info', title, description),
        dismiss,
    }
}
