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
        // Tanpa ini, browser menyimpan /src/*.js dengan Cache-Control
        // max-age bawaan Vite selama berjam-jam -- lewat Cloudflare Tunnel,
        // reload biasa/tab baru TETAP memakai JS lama yang di-cache walau
        // kode sumber & server sudah diperbarui, menyamar jadi "masih error"
        // padahal sudah diperbaiki. Dev server tidak seharusnya pernah
        // di-cache sama sekali.
        headers: {
            'Cache-Control': 'no-store',
        },
    },
})
