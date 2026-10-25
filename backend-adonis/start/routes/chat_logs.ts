/*
| Route modul 'chat_logs' (Tahap 3): chat staf, log aktivitas, status server.
| Path, method, dan middleware sama dengan backend-api/routes/api.php.
| Didaftarkan dari start/routes.ts.
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const ChatMessagesController = () => import('#controllers/chat_messages_controller')
const ActivityLogsController = () => import('#controllers/activity_logs_controller')
const SystemStatusController = () => import('#controllers/system_status_controller')

router
    .group(() => {
        // Gambar chat staf -- signed URL dari toPayload(); tanpa auth supaya
        // bisa dipakai langsung di <img>. Tanda tangan dicek di controller.
        router.get('/chat-messages/:chatMessage/image', [ChatMessagesController, 'image'])

        router
            .group(() => {
                // Chat staf per site -- dipanggil realtime-gateway dengan token
                // user yang sedang chat (lihat ChatMessagesController).
                router.get('/chat/messages', [ChatMessagesController, 'index'])
                router
                    .post('/chat/messages', [ChatMessagesController, 'store'])
                    .use(middleware.throttle({ max: 30, minutes: 1 }))
                router.get('/chat/messages/:chatMessage', [ChatMessagesController, 'show'])

                // Log aktivitas sistem (siapa melakukan apa) -- activity-logs.view.
                router.get('/activity-logs', [ActivityLogsController, 'index'])

                // Status semua layanan server -- super_admin saja.
                router
                    .get('/system/status', [SystemStatusController])
                    .use(middleware.throttle({ max: 30, minutes: 1 }))
            })
            .use([middleware.auth(), middleware.extendToken()])
    })
    .prefix('/api/v1')
