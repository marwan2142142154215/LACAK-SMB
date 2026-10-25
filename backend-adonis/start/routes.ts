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
const WorkSessionsController = () => import('#controllers/work_sessions_controller')
const DashboardSummaryController = () => import('#controllers/dashboard_summary_controller')

router.get('/health', () => ({ success: true, message: 'OK', data: null }))

router
    .group(() => {
        router
            .get('/auth/me', [AuthController, 'me'])
            .use([middleware.auth(), middleware.extendToken()])

        // Tanpa extendToken: cek ulang sesi oleh gateway tidak boleh
        // memperpanjang idle timeout.
        router.get('/auth/session', [AuthController, 'session']).use(middleware.auth())

        // Tahap 1: Live Kerja & ringkasan dashboard (docs/rencana-migrasi-adonis.md).
        router
            .group(() => {
                router.get('/dashboard-summary', [DashboardSummaryController, 'show'])

                router.get('/live/sites', [WorkSessionsController, 'sites'])
                router.get('/live/sessions', [WorkSessionsController, 'index'])
                router.get('/live/overview', [WorkSessionsController, 'overview'])
                router.post('/live/sessions/start', [WorkSessionsController, 'start'])
                router.post('/live/sessions/heartbeat', [WorkSessionsController, 'heartbeat'])
                router.post('/live/sessions/end', [WorkSessionsController, 'end'])
                router.get('/live/app', [WorkSessionsController, 'app'])
                router.get('/live/activity', [WorkSessionsController, 'activity'])
                router.post('/live/watch-token', [WorkSessionsController, 'watchToken'])
            })
            .use([middleware.auth(), middleware.extendToken()])
    })
    .prefix('/api/v1')

// Route per modul (Tahap 2-4). Tiap file mendefinisikan grupnya sendiri
// dengan prefix /api/v1.
await import('#start/routes/auth')
await import('#start/routes/users')
await import('#start/routes/devices')
await import('#start/routes/rules')
await import('#start/routes/chat_logs')
await import('#start/routes/apk')
