import { defineConfig } from '@adonisjs/core/http'

// Bot tidak membuka HTTP server; config ini hanya ada karena app_provider
// AdonisJS selalu membangun instance Server/router saat boot.
export const http = defineConfig({})
