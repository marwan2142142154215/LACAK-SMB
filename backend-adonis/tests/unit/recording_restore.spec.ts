import { test } from '@japa/runner'
import { parseRecordingPath, planRestore } from '#services/RecordingRestore'

const object = (path: string, lastModified: Date | null = new Date('2026-11-11T02:12:14Z')) => ({
    path,
    size: 1000,
    lastModified,
})

test.group('Pemulihan rekaman: membaca jalur berkas', () => {
    test('jalur rekaman dipecah jadi tanggal, folder staf, sumber, jam, dan track', ({
        assert,
    }) => {
        assert.deepEqual(
            parseRecordingPath(
                'recordings/2026-11-11/DEDY_SUSANTO/screen_share-081125-TR_VS4vvFFp.webm'
            ),
            {
                date: '2026-11-11',
                folder: 'DEDY_SUSANTO',
                source: 'screen_share',
                time: '08:11:25',
                trackSid: 'TR_VS4vvFFp',
            }
        )
    })

    test('jalur lain ditolak', ({ assert }) => {
        assert.isNull(parseRecordingPath('recordings/2026-11-11/DEDY_SUSANTO/catatan.txt'))
        assert.isNull(
            parseRecordingPath('recordings/12/5/2026-10-31/screen_share-123000-TR_A.webm')
        )
        assert.isNull(parseRecordingPath('lain/2026-11-11/X/camera-000000-TR_A.webm'))
    })
})

test.group('Pemulihan rekaman: rencana', () => {
    const users = [
        { id: 813, name: 'DEDY SUSANTO', organization_id: 16 },
        { id: 5, name: 'Budi Santoso', organization_id: 7 },
        { id: 6, name: 'Budi Santoso', organization_id: 8 },
        { id: 9, name: 'Tanpa Site', organization_id: null },
    ]

    test('berkas dicocokkan ke staf; jam lokal dibaca sebagai WIB', ({ assert }) => {
        const path = 'recordings/2026-11-11/DEDY_SUSANTO/screen_share-081125-TR_A1.webm'
        const plan = planRestore([object(path)], users, new Set())

        assert.lengthOf(plan.rows, 1)
        const [row] = plan.rows
        assert.equal(row.user_id, 813)
        assert.equal(row.organization_id, 16)
        assert.equal(row.source, 'screen_share')
        assert.equal(row.file_path, path)
        assert.equal(row.started_at.toISOString(), '2026-11-11T01:11:25.000Z')
        assert.equal(row.ended_at.toISOString(), '2026-11-11T02:12:14.000Z')
        assert.match(row.egress_id, /^RESTORED_[0-9a-f]{32}$/)
    })

    test('yang sudah punya baris, nama kembar, staf tak dikenal, dan bukan rekaman dilewati', ({
        assert,
    }) => {
        const exists = 'recordings/2026-11-11/DEDY_SUSANTO/screen_share-081125-TR_A1.webm'
        const plan = planRestore(
            [
                object(exists),
                object('recordings/2026-11-11/Budi_Santoso/camera-090000-TR_B.webm'),
                object('recordings/2026-11-11/Orang_Baru/camera-090000-TR_C.webm'),
                object('recordings/2026-11-11/Tanpa_Site/camera-090000-TR_D.webm'),
                object('recordings/2026-11-11/DEDY_SUSANTO/catatan.txt'),
            ],
            users,
            new Set([exists])
        )

        assert.lengthOf(plan.rows, 0)
        assert.deepEqual(plan.skipped, {
            existing: 1,
            unrecognized: 1,
            unknownStaff: 2,
            ambiguousStaff: 1,
        })
    })

    test('waktu selesai tidak mendahului waktu mulai', ({ assert }) => {
        const path = 'recordings/2026-11-11/DEDY_SUSANTO/camera-120000-TR_E.webm'
        const [row] = planRestore(
            [object(path, new Date('2026-11-11T00:00:00Z'))],
            users,
            new Set()
        ).rows
        assert.equal(row.ended_at.getTime(), row.started_at.getTime())
    })
})
