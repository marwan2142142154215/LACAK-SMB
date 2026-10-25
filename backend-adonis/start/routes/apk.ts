/*
| Route modul 'apk' (Tahap 4) -- path, method, dan nama parameter sama
| dengan backend-api (php artisan route:list --path=api/v1/apk-builds).
| Didaftarkan dari start/routes.ts.
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const ApkBuildsController = () => import('#controllers/apk_builds_controller')

router
    .group(() => {
        // Tanpa login: dilindungi tanda tangan URL (middleware `signed` di
        // Laravel), diperiksa di controller.
        router.get('/apk-builds/:apkBuild/download', [ApkBuildsController, 'download'])

        router
            .group(() => {
                router.get('/apk-builds', [ApkBuildsController, 'index'])
                router.post('/apk-builds', [ApkBuildsController, 'store'])
                router.post('/apk-builds/generate', [ApkBuildsController, 'generate'])
                router.get('/apk-builds/:apk_build', [ApkBuildsController, 'show'])
                router.delete('/apk-builds/:apk_build', [ApkBuildsController, 'destroy'])
            })
            .use([middleware.auth(), middleware.extendToken()])
    })
    .prefix('/api/v1')
