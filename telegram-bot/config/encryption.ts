import env from '#start/env'
import { defineConfig, drivers } from '@adonisjs/core/encryption'

// Bot tidak mengenkripsi apa pun, tetapi app_provider AdonisJS membangun
// router (dan karena itu layanan encryption) saat boot, sehingga config ini
// wajib ada agar aplikasi bisa berjalan.
const encryptionConfig = defineConfig({
    default: 'gcm',

    list: {
        gcm: drivers.aes256gcm({
            keys: [env.get('APP_KEY')],
            id: 'gcm',
        }),
    },
})

export default encryptionConfig

declare module '@adonisjs/core/types' {
    export interface EncryptorsList extends InferEncryptors<typeof encryptionConfig> {}
}
