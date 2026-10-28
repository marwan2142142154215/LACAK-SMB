/*
|--------------------------------------------------------------------------
| Route modul device (Tahap 3)
|--------------------------------------------------------------------------
|
| Padanan route device di backend-api/routes/api.php: path, method, nama
| parameter ({device}), dan middleware sama persis.
|
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const DevicesController = () => import('#controllers/devices_controller')
const DeviceCommandsController = () => import('#controllers/device_commands_controller')
const DeviceOtpController = () => import('#controllers/device_otp_controller')
const DeviceEnrollmentController = () => import('#controllers/device_enrollment_controller')
const ViolationLogsController = () => import('#controllers/violation_logs_controller')

router
    .group(() => {
        // Dipanggil langsung oleh APK pelacak di device target yang sedang
        // terkunci (tidak bisa login) — diamankan via device_uuid+OTP+rate
        // limit, bukan token login. Lihat catatan di DeviceOtpController.
        router
            .post('/device-otp/verify', [DeviceOtpController, 'verify'])
            .use(middleware.throttle({ max: 10, minutes: 1 }))

        // Dipanggil APK pelacak untuk mengambil rahasia device (sekali per
        // pendaftaran) — belum punya kredensial apa pun, jadi tanpa login;
        // dibatasi rate limit dan hanya berlaku untuk device pending_enrollment.
        router
            .post('/device-enrollments/claim', [DeviceEnrollmentController, 'claim'])
            .use(middleware.throttle({ max: 10, minutes: 1 }))

        router
            .group(() => {
                // apiResource('devices')
                router.get('/devices', [DevicesController, 'index'])
                router.post('/devices', [DevicesController, 'store'])
                router.get('/devices/:device', [DevicesController, 'show'])
                // PUT & PATCH = satu route (apiResource Laravel); dua route terpisah
                // dengan handler sama bentrok nama otomatisnya di router Adonis.
                router.route('/devices/:device', ['PUT', 'PATCH'], [DevicesController, 'update'])
                router.put('/devices/:device/site', [DevicesController, 'moveSite'])
                router.delete('/devices/:device', [DevicesController, 'destroy'])

                router.get('/devices/:device/commands', [DeviceCommandsController, 'index'])
                router.post('/devices/:device/commands', [DeviceCommandsController, 'store'])
                router.post('/devices/:device/otp', [DeviceOtpController, 'generate'])
                router.post('/devices/:device/re-enroll', [DeviceEnrollmentController, 'reEnroll'])
                router.get('/devices/:device/violations', [ViolationLogsController, 'index'])
            })
            .use([middleware.auth(), middleware.extendToken()])
    })
    .prefix('/api/v1')
