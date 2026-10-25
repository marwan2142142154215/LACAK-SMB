import { test } from '@japa/runner'
import { parseTransport } from '#services/live_hub'

test.group('Live Kerja: jalur video dari live:state', () => {
    test('hanya udp/tcp yang diterima', ({ assert }) => {
        assert.equal(parseTransport({ transport: 'udp' }), 'udp')
        assert.equal(parseTransport({ transport: 'tcp' }), 'tcp')
        assert.isNull(parseTransport({ transport: 'TCP' }))
        assert.isNull(parseTransport({ transport: '<b>tcp</b>' }))
        assert.isNull(parseTransport({ camera_active: true }))
        assert.isNull(parseTransport(null))
        assert.isNull(parseTransport('tcp'))
    })
})
