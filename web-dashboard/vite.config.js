import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
    plugins: [vue(), tailwindcss()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    server: {
        port: 5173,
        // Cloudflare Tunnel meneruskan Host: app.lacaksmbbot.com ke dev
        // server ini — Vite 5+ menolak Host header asing secara default.
        allowedHosts: ['app.lacaksmbbot.com'],
    },
})
