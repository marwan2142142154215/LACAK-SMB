import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import PersonalAccessToken from '#models/personal_access_token'
import { runBriefingSchedules } from '#services/briefing_schedule'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'
import { localDate } from '#services/local_time'
import { runWorkAlerts } from '#services/work_alerts'

async function site(name: string) {
    const [org] = await db
        .table('organizations')
        .insert({
            name,
            type: 'company_asset',
            unique_site_code: `UJI-${randomBytes(4).toString('hex').toUpperCase()}`,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])
    return org.id as number
}

/** User dengan satu peran + bearer token; admin/leader diberi akses ke [granted]. */
async function person(role: string, organizationId: number | null, granted: number[] = []) {
    const suffix = randomBytes(4).toString('hex')
    const [user] = await db
        .table('users')
        .insert({
            username: `kerja.${role}.${suffix}`,
            name: `Kerja ${role} ${suffix}`,
            email: `kerja.${role}.${suffix}@example.test`,
            password: '$2y$10$Y18XUtkwVNaSkDxG0mGKX.51ec8i1y3rdvE4Cc.QSg9izFzIo/CiO',
            organization_id: organizationId,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])
    const roleRow = await db.from('roles').where({ name: role, guard_name: 'web' }).firstOrFail()
    await db.table('model_has_roles').insert({
        role_id: roleRow.id,
        model_type: LARAVEL_USER_MORPH,
        model_id: user.id,
    })
    for (const id of granted) {
        await db.table('user_site_access').insert({
            user_id: user.id,
            organization_id: id,
            created_at: new Date(),
            updated_at: new Date(),
        })
    }
    const plain = randomBytes(20).toString('hex')
    const token = await PersonalAccessToken.create({
        tokenableType: LARAVEL_USER_MORPH,
        tokenableId: user.id,
        name: `web_dashboard-${Date.now()}`,
        deviceType: 'computer',
        token: createHash('sha256').update(plain).digest('hex'),
        abilities: '["*"]',
        expiresAt: DateTime.now().plus({ hours: 2 }),
    })
    return { id: user.id as number, bearer: `${token.id}|${plain}` }
}

test.group('Shift & absensi', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('leader membuat shift di site-nya, memasang staf, absensi menandai tidak masuk', async ({
        client,
        assert,
    }) => {
        const mine = await site('Site Shift Milik')
        const other = await site('Site Shift Lain')
        const leader = await person('leader', null, [mine])
        const staff = await person('staff_viewer', mine)
        const outsider = await person('staff_viewer', other)

        const foreign = await client
            .post('/api/v1/work-shifts')
            .json({
                organization_id: other,
                name: 'Pagi',
                start_time: '08:00',
                end_time: '17:00',
                days: [1, 2, 3, 4, 5],
                late_tolerance_minutes: 10,
            })
            .bearerToken(leader.bearer)
        foreign.assertStatus(403)

        // Shift setiap hari, sudah selesai sebelum sekarang: staf yang tidak kerja = tidak masuk.
        const created = await client
            .post('/api/v1/work-shifts')
            .json({
                organization_id: mine,
                name: 'Dini hari',
                start_time: '00:00',
                end_time: '00:01',
                days: [1, 2, 3, 4, 5, 6, 7],
                late_tolerance_minutes: 0,
            })
            .bearerToken(leader.bearer)
        created.assertStatus(201)
        const shiftId = created.body().data.id

        const outsiderAssign = await client
            .put('/api/v1/work-shifts/assignments')
            .json({ user_ids: [outsider.id], work_shift_id: shiftId })
            .bearerToken(leader.bearer)
        outsiderAssign.assertStatus(403)

        const assigned = await client
            .put('/api/v1/work-shifts/assignments')
            .json({ user_ids: [staff.id], work_shift_id: shiftId })
            .bearerToken(leader.bearer)
        assigned.assertStatus(200)

        const yesterday = localDate(new Date(Date.now() - 86_400_000))
        const report = await client
            .get('/api/v1/attendance')
            .qs({ organization_id: mine, from: yesterday, to: yesterday })
            .bearerToken(leader.bearer)
        report.assertStatus(200)
        const row = report
            .body()
            .data.items.find((item: { user_id: number }) => item.user_id === staff.id)
        assert.equal(row.status, 'absent')
        assert.equal(row.shift.name, 'Dini hari')

        // Staf hanya melihat dirinya sendiri.
        const own = await client
            .get('/api/v1/attendance')
            .qs({ from: yesterday, to: yesterday })
            .bearerToken(staff.bearer)
        own.assertStatus(200)
        assert.deepEqual(
            own.body().data.items.map((item: { user_id: number }) => item.user_id),
            [staff.id]
        )
        const deniedSettings = await client
            .get(`/api/v1/work-alert-settings/${mine}`)
            .bearerToken(staff.bearer)
        deniedSettings.assertStatus(403)
    })
})

test.group('Izin & cuti', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('staf mengajukan, leader site menyetujui, absensi mencatat izin', async ({
        client,
        assert,
    }) => {
        const mine = await site('Site Izin')
        const leader = await person('leader', null, [mine])
        const staff = await person('staff_viewer', mine)
        const colleague = await person('staff_viewer', mine)
        const today = localDate()

        const submitted = await client
            .post('/api/v1/leave-requests')
            .json({ type: 'sakit', start_date: today, end_date: today, reason: 'Demam tinggi' })
            .bearerToken(staff.bearer)
        submitted.assertStatus(201)
        const id = submitted.body().data.id

        const overlap = await client
            .post('/api/v1/leave-requests')
            .json({ type: 'izin', start_date: today, end_date: today, reason: 'Keperluan lain' })
            .bearerToken(staff.bearer)
        overlap.assertStatus(422)

        const byColleague = await client
            .post(`/api/v1/leave-requests/${id}/review`)
            .json({ status: 'approved' })
            .bearerToken(colleague.bearer)
        byColleague.assertStatus(403)

        const list = await client.get('/api/v1/leave-requests').bearerToken(leader.bearer)
        assert.equal(list.body().data.pending_count, 1)

        const approved = await client
            .post(`/api/v1/leave-requests/${id}/review`)
            .json({ status: 'approved', note: 'Semoga lekas sembuh' })
            .bearerToken(leader.bearer)
        approved.assertStatus(200)
        assert.equal(approved.body().data.status, 'approved')

        const report = await client
            .get('/api/v1/attendance')
            .qs({ from: today, to: today })
            .bearerToken(staff.bearer)
        assert.equal(report.body().data.items[0].status, 'leave')
        assert.equal(report.body().data.items[0].leave_type, 'sakit')
    })
})

test.group('Pengumuman', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('hanya untuk site & peran tujuan, tanda sudah dibaca terlihat penulis', async ({
        client,
        assert,
    }) => {
        const mine = await site('Site Pengumuman')
        const other = await site('Site Pengumuman Lain')
        const leader = await person('leader', null, [mine])
        const staff = await person('staff_viewer', mine)
        const outsider = await person('staff_viewer', other)

        const foreign = await client
            .post('/api/v1/announcements')
            .json({ title: 'Info', body: 'Isi', organization_ids: [other] })
            .bearerToken(leader.bearer)
        foreign.assertStatus(403)
        const denied = await client
            .post('/api/v1/announcements')
            .json({ title: 'Info', body: 'Isi' })
            .bearerToken(staff.bearer)
        denied.assertStatus(403)

        const created = await client
            .post('/api/v1/announcements')
            .json({ title: 'Libur nasional', body: 'Kantor tutup Senin.', roles: ['staff_viewer'] })
            .bearerToken(leader.bearer)
        created.assertStatus(201)
        const id = created.body().data.id

        const forStaff = await client.get('/api/v1/announcements').bearerToken(staff.bearer)
        assert.equal(forStaff.body().data.unread_count, 1)
        const forOutsider = await client.get('/api/v1/announcements').bearerToken(outsider.bearer)
        assert.lengthOf(forOutsider.body().data.items, 0)
        const outsiderRead = await client
            .post(`/api/v1/announcements/${id}/read`)
            .bearerToken(outsider.bearer)
        outsiderRead.assertStatus(404)

        await client.post(`/api/v1/announcements/${id}/read`).bearerToken(staff.bearer)
        const after = await client.get('/api/v1/announcements').bearerToken(staff.bearer)
        assert.equal(after.body().data.unread_count, 0)

        const readers = await client
            .get(`/api/v1/announcements/${id}/readers`)
            .bearerToken(leader.bearer)
        assert.deepEqual(
            readers.body().data.items.map((reader: { user_id: number }) => reader.user_id),
            [staff.id]
        )
    })
})

test.group('Briefing terjadwal & daftar hadir', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('dijadwalkan, dibuka scheduler tepat waktu, kehadiran tercatat', async ({
        client,
        assert,
    }) => {
        const mine = await site('Site Briefing Jadwal')
        const leader = await person('leader', null, [mine])
        const staff = await person('staff_viewer', mine)
        const absentee = await person('staff_viewer', mine)
        const tomorrow = localDate(new Date(Date.now() + 86_400_000))

        const scheduled = await client
            .post('/api/v1/briefings')
            .json({
                title: 'Briefing pagi',
                user_ids: [staff.id, absentee.id],
                schedule: {
                    date: tomorrow,
                    time: '08:00',
                    recurrence: 'weekdays',
                    duration_minutes: 30,
                },
            })
            .bearerToken(leader.bearer)
        scheduled.assertStatus(201)
        const scheduleId = scheduled.body().data.schedule.id

        const pastOnce = await client
            .post('/api/v1/briefings')
            .json({
                title: 'Lewat',
                user_ids: [staff.id],
                schedule: {
                    date: '2020-01-01',
                    time: '08:00',
                    recurrence: 'once',
                    duration_minutes: 30,
                },
            })
            .bearerToken(leader.bearer)
        pastOnce.assertStatus(422)

        const forStaff = await client.get('/api/v1/briefings').bearerToken(staff.bearer)
        const upcoming = forStaff.body().data.upcoming
        assert.lengthOf(upcoming, 1)
        assert.equal(upcoming[0].title, 'Briefing pagi')
        assert.isFalse(upcoming[0].can_cancel)
        assert.lengthOf(forStaff.body().data.items, 0)

        // Jam jadwalnya tiba.
        const schedule = await db.from('briefing_schedules').where('id', scheduleId).first()
        const result = await runBriefingSchedules(new Date(schedule.next_run_at.getTime() + 1000))
        assert.equal(result.started, 1)
        const advanced = await db.from('briefing_schedules').where('id', scheduleId).first()
        assert.isAbove(advanced.next_run_at.getTime(), schedule.next_run_at.getTime())

        const live = await client.get('/api/v1/briefings').bearerToken(staff.bearer)
        const briefing = live.body().data.items[0]
        assert.isTrue(briefing.scheduled)

        const ping = await client
            .post(`/api/v1/briefings/${briefing.id}/presence`)
            .bearerToken(staff.bearer)
        ping.assertStatus(200)
        const deniedAttendance = await client
            .get(`/api/v1/briefings/${briefing.id}/attendance`)
            .bearerToken(staff.bearer)
        deniedAttendance.assertStatus(403)

        const attendance = await client
            .get(`/api/v1/briefings/${briefing.id}/attendance`)
            .bearerToken(leader.bearer)
        attendance.assertStatus(200)
        assert.deepEqual(
            attendance.body().data.attended.map((row: { user_id: number }) => row.user_id),
            [staff.id]
        )
        assert.deepEqual(
            attendance.body().data.absent.map((row: { user_id: number }) => row.user_id),
            [absentee.id]
        )

        const cancelled = await client
            .delete(`/api/v1/briefing-schedules/${scheduleId}`)
            .bearerToken(leader.bearer)
        cancelled.assertStatus(200)
        const after = await client.get('/api/v1/briefings').bearerToken(staff.bearer)
        assert.lengthOf(after.body().data.upcoming, 0)
    })
})

test.group('Peringatan kerja & catatan kerja', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('kamera mati terlalu lama dicatat sekali; catatan Selesai kerja tampil di log', async ({
        client,
        assert,
    }) => {
        const mine = await site('Site Peringatan')
        const leader = await person('leader', null, [mine])
        const staff = await person('staff_viewer', mine)
        await db.from('work_alert_settings').where('organization_id', mine).delete()
        await db.table('work_alert_settings').insert({
            organization_id: mine,
            alerts_enabled: true,
            camera_off_minutes: 10,
            face_missing_minutes: 10,
            absent_alert: false,
            daily_report: false,
            weekly_report: false,
            report_time: '23:59',
        })

        const started = await client
            .post('/api/v1/live/sessions/start')
            .json({ device: 'computer' })
            .bearerToken(staff.bearer)
        started.assertStatus(201)
        const sessionId = started.body().data.session.id
        await db
            .from('work_sessions')
            .where('id', sessionId)
            .update({ started_at: new Date(Date.now() - 15 * 60_000) })

        await runWorkAlerts()
        await runWorkAlerts()
        const alerts = await db
            .from('work_alerts')
            .where('organization_id', mine)
            .where('user_id', staff.id)
            .select('type')
        // Kamera & layar sama-sama mati: satu peringatan saja.
        assert.deepEqual(
            alerts.map((alert) => alert.type),
            ['camera_off']
        )

        const list = await client
            .get('/api/v1/work-alerts')
            .qs({ organization_id: mine })
            .bearerToken(leader.bearer)
        list.assertStatus(200)
        assert.lengthOf(list.body().data.items, 1)

        const ended = await client
            .post('/api/v1/live/sessions/end')
            .json({ note: 'Selesai input 40 faktur.' })
            .bearerToken(staff.bearer)
        ended.assertStatus(200)
        const activity = await client
            .get('/api/v1/live/activity')
            .qs({
                organization_id: mine,
                from: new Date(Date.now() - 3600_000).toISOString(),
                to: new Date(Date.now() + 60_000).toISOString(),
            })
            .bearerToken(leader.bearer)
        activity.assertStatus(200)
        assert.equal(activity.body().data.notes[0].note, 'Selesai input 40 faktur.')
    })
})

test.group('Peringatan belum Mulai kerja', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('hanya staf terjadwal yang belum mulai, dicatat sekali per hari', async ({ assert }) => {
        const mine = await site('Site Absen')
        const late = await person('staff_viewer', mine)
        const working = await person('staff_viewer', mine)
        const offToday = await person('staff_viewer', mine)
        const now = DateTime.now().setZone('Asia/Jakarta')
        // Shift mulai 30 menit lalu (toleransi 10 menit) -- masih dalam jendela peringatan.
        const start = now.minus({ minutes: 30 })
        const [shift] = await db
            .table('work_shifts')
            .insert({
                organization_id: mine,
                name: 'Uji',
                start_time: start.toFormat('HH:mm'),
                end_time: start.plus({ hours: 8 }).toFormat('HH:mm'),
                days: JSON.stringify([now.weekday]),
                late_tolerance_minutes: 10,
            })
            .returning(['id'])
        const [other] = await db
            .table('work_shifts')
            .insert({
                organization_id: mine,
                name: 'Libur',
                start_time: start.toFormat('HH:mm'),
                end_time: start.plus({ hours: 8 }).toFormat('HH:mm'),
                days: JSON.stringify([(now.weekday % 7) + 1]),
                late_tolerance_minutes: 10,
            })
            .returning(['id'])
        await db.table('staff_shifts').multiInsert([
            { user_id: late.id, work_shift_id: shift.id },
            { user_id: working.id, work_shift_id: shift.id },
            { user_id: offToday.id, work_shift_id: other.id },
        ])
        await db.table('work_session_events').insert({
            user_id: working.id,
            organization_id: mine,
            type: 'work_start',
            status: 'working',
            occurred_at: start.plus({ minutes: 2 }).toJSDate(),
            created_at: new Date(),
            updated_at: new Date(),
        })

        await runWorkAlerts()
        await runWorkAlerts()
        const rows = await db
            .from('work_alerts')
            .where('organization_id', mine)
            .where('type', 'absent')
            .select('user_id')
        assert.deepEqual(
            rows.map((row) => row.user_id),
            [late.id]
        )
    })
})

test.group('Batas site: izin staf pindah & pengingat briefing', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('pengajuan staf yang pindah site ditinjau pengelola site barunya', async ({ client }) => {
        const oldSite = await site('Site Lama')
        const newSite = await site('Site Baru')
        const oldLeader = await person('leader', null, [oldSite])
        const newLeader = await person('leader', null, [newSite])
        const staff = await person('staff_viewer', oldSite)
        const day = localDate(new Date(Date.now() + 3 * 86_400_000))

        const submitted = await client
            .post('/api/v1/leave-requests')
            .json({ type: 'cuti', start_date: day, end_date: day, reason: 'Urusan keluarga' })
            .bearerToken(staff.bearer)
        submitted.assertStatus(201)
        await db.from('users').where('id', staff.id).update({ organization_id: newSite })

        const byOld = await client
            .post(`/api/v1/leave-requests/${submitted.body().data.id}/review`)
            .json({ status: 'approved' })
            .bearerToken(oldLeader.bearer)
        byOld.assertStatus(403)
        const byNew = await client
            .post(`/api/v1/leave-requests/${submitted.body().data.id}/review`)
            .json({ status: 'approved' })
            .bearerToken(newLeader.bearer)
        byNew.assertStatus(200)
    })

    test('pengingat briefing hanya ke chat site yang dipegang pemimpin', async ({
        client,
        assert,
    }) => {
        const mine = await site('Site Pemimpin')
        const other = await site('Site Rumah Tamu')
        const host = await person('leader', null, [mine])
        const staff = await person('staff_viewer', mine)
        // Leader dari site lain yang diberi akses ke site pemimpin: bisa diundang.
        const guest = await person('leader', other, [mine])
        const tomorrow = localDate(new Date(Date.now() + 86_400_000))

        const scheduled = await client
            .post('/api/v1/briefings')
            .json({
                title: 'Rapat rahasia',
                user_ids: [staff.id, guest.id],
                schedule: {
                    date: tomorrow,
                    time: '09:00',
                    recurrence: 'once',
                    duration_minutes: 30,
                },
            })
            .bearerToken(host.bearer)
        scheduled.assertStatus(201)
        const schedule = await db
            .from('briefing_schedules')
            .where('id', scheduled.body().data.schedule.id)
            .first()

        await runBriefingSchedules(new Date(schedule.next_run_at.getTime() - 5 * 60_000))
        const reminders = await db
            .from('work_alerts')
            .where('type', 'briefing_reminder')
            .whereIn('organization_id', [mine, other])
            .select('organization_id')
        assert.deepEqual(
            reminders.map((row) => row.organization_id),
            [mine]
        )
    })
})
