import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const WorkShiftsController = () => import('#controllers/work_shifts_controller')
const AttendanceController = () => import('#controllers/attendance_controller')
const LeaveRequestsController = () => import('#controllers/leave_requests_controller')
const AnnouncementsController = () => import('#controllers/announcements_controller')
const StaffWarningsController = () => import('#controllers/staff_warnings_controller')

/** Pengelolaan kerja: shift, absensi, peringatan, izin/cuti, pengumuman, peringatan staf. */
router
    .group(() => {
        router.get('/work-shifts', [WorkShiftsController, 'index'])
        router.post('/work-shifts', [WorkShiftsController, 'store'])
        router.put('/work-shifts/assignments', [WorkShiftsController, 'assign'])
        router.put('/work-shifts/:id', [WorkShiftsController, 'update'])
        router.delete('/work-shifts/:id', [WorkShiftsController, 'destroy'])

        router.get('/attendance', [AttendanceController, 'index'])
        router.get('/work-alerts', [AttendanceController, 'alerts'])
        router
            .get('/work-alert-settings/:organizationId', [AttendanceController, 'showSettings'])
            .where('organizationId', /^\d+$/)
        router
            .put('/work-alert-settings/:organizationId', [AttendanceController, 'updateSettings'])
            .where('organizationId', /^\d+$/)

        router.get('/leave-requests', [LeaveRequestsController, 'index'])
        router
            .post('/leave-requests', [LeaveRequestsController, 'store'])
            .use(middleware.throttle({ max: 10, minutes: 1 }))
        router.post('/leave-requests/:id/review', [LeaveRequestsController, 'review'])
        router.post('/leave-requests/:id/cancel', [LeaveRequestsController, 'cancel'])

        router.get('/announcements', [AnnouncementsController, 'index'])
        router
            .post('/announcements', [AnnouncementsController, 'store'])
            .use(middleware.throttle({ max: 10, minutes: 1 }))
        router.post('/announcements/:id/read', [AnnouncementsController, 'read'])
        router.get('/announcements/:id/readers', [AnnouncementsController, 'readers'])
        router.delete('/announcements/:id', [AnnouncementsController, 'destroy'])

        router.get('/staff-warnings', [StaffWarningsController, 'index'])
        router.get('/staff-warnings/pending', [StaffWarningsController, 'pending'])
        router
            .post('/staff-warnings', [StaffWarningsController, 'store'])
            .use(middleware.throttle({ max: 20, minutes: 1 }))
        router
            .post('/staff-warnings/:id/acknowledge', [StaffWarningsController, 'acknowledge'])
            .where('id', /^\d+$/)
    })
    .prefix('/api/v1')
    .use([middleware.auth(), middleware.extendToken()])
