/*
|--------------------------------------------------------------------------
| Route modul aturan (Tahap 3): geofence & Telegram
|--------------------------------------------------------------------------
|
| Path, method, dan nama parameter sama persis dengan backend-api
| (php artisan route:list --path=api) -- middleware log aktivitas API
| mencocokkan pola path ini.
|
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const GeofenceRulesController = () => import('#controllers/geofence_rules_controller')
const TelegramBindingsController = () => import('#controllers/telegram_bindings_controller')
const TelegramUserLinksController = () => import('#controllers/telegram_user_links_controller')

// Id selain angka tidak pernah cocok dengan baris mana pun (404).
const id = router.matchers.number()

router
    .group(() => {
        router
            .group(() => {
                router.get('/geofence-rules', [GeofenceRulesController, 'index'])
                router.post('/geofence-rules', [GeofenceRulesController, 'store'])
                router
                    .route(
                        '/geofence-rules/:geofence_rule',
                        ['PUT', 'PATCH'],
                        [GeofenceRulesController, 'update']
                    )
                    .where('geofence_rule', id)
                router
                    .delete('/geofence-rules/:geofence_rule', [GeofenceRulesController, 'destroy'])
                    .where('geofence_rule', id)

                router.get('/telegram-bindings', [TelegramBindingsController, 'index'])
                router.post('/telegram-bindings', [TelegramBindingsController, 'store'])
                router.get('/telegram-bindings-lookup', [TelegramBindingsController, 'lookup'])
                router
                    .delete('/telegram-bindings/:telegram_binding', [
                        TelegramBindingsController,
                        'destroy',
                    ])
                    .where('telegram_binding', id)

                router.get('/telegram-user-links', [TelegramUserLinksController, 'index'])
                router.post('/telegram-user-links', [TelegramUserLinksController, 'store'])
                router.get('/telegram-user-links-lookup', [TelegramUserLinksController, 'lookup'])
                router
                    .delete('/telegram-user-links/:telegram_user_link', [
                        TelegramUserLinksController,
                        'destroy',
                    ])
                    .where('telegram_user_link', id)
            })
            .use([middleware.auth(), middleware.extendToken()])
    })
    .prefix('/api/v1')
