import { test } from '@japa/runner'
import { activeRecordingSources } from '#services/Recording'

test.group('Rekaman: sumber yang direkam', () => {
    test('kosong atau tidak diisi = kamera dan layar', ({ assert }) => {
        assert.deepEqual(activeRecordingSources(undefined), ['camera', 'screen_share'])
        assert.deepEqual(activeRecordingSources('  '), ['camera', 'screen_share'])
    })

    test('bisa dibatasi ke layar saja, huruf besar dan spasi diabaikan', ({ assert }) => {
        assert.deepEqual(activeRecordingSources('screen_share'), ['screen_share'])
        assert.deepEqual(activeRecordingSources(' Camera , SCREEN_SHARE '), [
            'camera',
            'screen_share',
        ])
    })

    test('nilai tidak dikenal diabaikan; semua tak dikenal = tidak merekam apa pun', ({
        assert,
    }) => {
        assert.deepEqual(activeRecordingSources('camera,audio'), ['camera'])
        assert.deepEqual(activeRecordingSources('audio'), [])
    })
})
