import env from '#start/env'
import { defineConfig, targets } from '@adonisjs/core/logger'

// Log berupa JSON ke stdout. syncDestination() bawaan template AdonisJS
// sengaja tidak dipakai karena butuh paket pino-pretty, yang tidak termasuk
// dependensi aplikasi ini.
const loggerConfig = defineConfig({
    default: 'app',

    loggers: {
        app: {
            enabled: true,
            name: 'telegram-bot',
            level: env.get('LOG_LEVEL'),
            transport: {
                targets: [targets.file({ destination: 1 })],
            },
        },
    },
})

export default loggerConfig

declare module '@adonisjs/core/types' {
    export interface LoggersList extends InferLoggers<typeof loggerConfig> {}
}
