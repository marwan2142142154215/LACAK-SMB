import { defineConfig } from '@adonisjs/core/app'

export default defineConfig({
    /*
    |--------------------------------------------------------------------------
    | Commands
    |--------------------------------------------------------------------------
    |
    | Perintah aplikasi (termasuk "bot:run") dipindai otomatis dari folder
    | "./commands".
    |
    */
    commands: [() => import('@adonisjs/core/commands')],

    /*
    |--------------------------------------------------------------------------
    | Service providers
    |--------------------------------------------------------------------------
    |
    | Sengaja minimal: bot tidak memakai HTTP server, database, sesi, atau
    | auth sendiri -- semua data diambil lewat backend-api.
    |
    */
    providers: [
        () => import('@adonisjs/core/providers/app_provider'),
        {
            file: () => import('@adonisjs/core/providers/repl_provider'),
            environment: ['repl'],
        },
    ],

    preloads: [],

    metaFiles: [],
})
