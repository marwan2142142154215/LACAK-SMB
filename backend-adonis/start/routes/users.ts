/*
|--------------------------------------------------------------------------
| Route modul staf, site & pengaturan keamanan (Tahap 3)
|--------------------------------------------------------------------------
|
| Padanan apiResource('organizations'), apiResource('users') + aksi staf,
| dan /settings/security di backend-api/routes/api.php. Nama parameter
| sama dengan Laravel ({organization}, {user}). Semuanya wajib login dan
| menggeser idle timeout token (auth:sanctum + extend-token).
|
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const UsersController = () => import('#controllers/UsersController')
const OrganizationsController = () => import('#controllers/OrganizationsController')
const SecuritySettingsController = () => import('#controllers/SecuritySettingsController')

router
    .group(() => {
        router.get('/organizations', [OrganizationsController, 'index'])
        router.post('/organizations', [OrganizationsController, 'store'])
        router.get('/organizations/:organization', [OrganizationsController, 'show'])
        // PUT & PATCH = satu route (apiResource Laravel); dua route terpisah
        // dengan handler sama bentrok nama otomatisnya di router Adonis.
        router.route(
            '/organizations/:organization',
            ['PUT', 'PATCH'],
            [OrganizationsController, 'update']
        )
        router.delete('/organizations/:organization', [OrganizationsController, 'destroy'])

        router.get('/users', [UsersController, 'index'])
        router.post('/users', [UsersController, 'store'])
        router.get('/users/:user', [UsersController, 'show'])
        // PUT & PATCH = satu route (apiResource Laravel); dua route terpisah
        // dengan handler sama bentrok nama otomatisnya di router Adonis.
        router.route('/users/:user', ['PUT', 'PATCH'], [UsersController, 'update'])
        router.delete('/users/:user', [UsersController, 'destroy'])
        router.post('/users/:user/suspend', [UsersController, 'suspend'])
        router.post('/users/:user/reactivate', [UsersController, 'reactivate'])
        router.post('/users/:user/reset-2fa', [UsersController, 'reset2fa'])
        router.put('/users/:user/site-access', [UsersController, 'syncSiteAccess'])
        // Atur akses site banyak user sekaligus (tambah / cabut / ganti, atau semua site).
        router
            .post('/users/bulk-site-access', [UsersController, 'bulkSiteAccess'])
            .use(middleware.throttle({ max: 10, minutes: 1 }))

        // Wajib/tidaknya 2FA -- security.manage (super_admin) saja.
        router.get('/settings/security', [SecuritySettingsController, 'show'])
        router.put('/settings/security', [SecuritySettingsController, 'update'])
        router.get('/settings/ip-whitelist', [SecuritySettingsController, 'ipWhitelist'])
        router.put('/settings/ip-whitelist', [SecuritySettingsController, 'updateIpWhitelist'])
    })
    .prefix('/api/v1')
    .use([middleware.auth(), middleware.extendToken()])
