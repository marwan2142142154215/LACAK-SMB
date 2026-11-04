import { test } from '@japa/runner'
import { backoffMs, recordingSourceOf, tracksToStart } from '#services/RecordingReconcile'

test.group('Pemeriksa rekaman: membaca track LiveKit', () => {
    test('sumber track dikenali dari nama maupun angka enum', ({ assert }) => {
        assert.equal(recordingSourceOf('CAMERA'), 'camera')
        assert.equal(recordingSourceOf('SCREEN_SHARE'), 'screen_share')
        assert.equal(recordingSourceOf(1), 'camera')
        assert.equal(recordingSourceOf(3), 'screen_share')
        assert.isNull(recordingSourceOf('MICROPHONE'))
        assert.isNull(recordingSourceOf(2))
        assert.isNull(recordingSourceOf(undefined))
    })

    test('hanya track staf itu yang belum direkam dan sumbernya diinginkan', ({ assert }) => {
        const tracks = [
            { identity: 'user-5', sid: 'TR_cam', source: 'CAMERA' },
            { identity: 'user-5', sid: 'TR_scr', source: 'SCREEN_SHARE' },
            { identity: 'user-5', sid: 'TR_mic', source: 'MICROPHONE' },
            { identity: 'user-9', sid: 'TR_other', source: 'CAMERA' },
        ]
        assert.deepEqual(
            tracksToStart(5, tracks, new Set(['TR_cam']), ['camera', 'screen_share']),
            [{ sid: 'TR_scr', source: 'screen_share' }]
        )
        assert.deepEqual(tracksToStart(5, tracks, new Set(), ['screen_share']), [
            { sid: 'TR_scr', source: 'screen_share' },
        ])
        assert.deepEqual(tracksToStart(5, [], new Set(), ['camera']), [])
    })

    test('jeda percobaan ulang naik bertahap lalu mendatar', ({ assert }) => {
        assert.equal(backoffMs(1), 60_000)
        assert.equal(backoffMs(2), 120_000)
        assert.equal(backoffMs(4), 600_000)
        assert.equal(backoffMs(50), 600_000)
    })
})
