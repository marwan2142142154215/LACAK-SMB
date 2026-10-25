/*
|--------------------------------------------------------------------------
| Routes
|--------------------------------------------------------------------------
|
| Path & bentuk jawaban sama persis dengan backend-api (Laravel). Path yang
| sudah ada di sini baru melayani pengguna setelah nginx mengarahkannya ke
| aplikasi ini (docs/rencana-migrasi-adonis.md, "Cara memindahkan satu modul").
|
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const AuthController = () => import('#controllers/auth_controller')

router.get('/health', () => ({ success: true, message: 'OK', data: null }))

router
    .group(() => {
        router
            .get('/auth/me', [AuthController, 'me'])
            .use([middleware.auth(), middleware.extendToken()])

        // Tanpa extendToken: cek ulang sesi oleh gateway tidak boleh
        // memperpanjang idle timeout.
        router.get('/auth/session', [AuthController, 'session']).use(middleware.auth())
    })
    .prefix('/api/v1')
