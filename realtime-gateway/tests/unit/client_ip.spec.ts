import { test } from '@japa/runner'
import { clientIpOf, forgetClientIp, rememberClientIp, userHeaders } from '#services/client_ip'

test.group('IP klien untuk whitelist backend', () => {
    test('X-Forwarded-For hanya dipercaya dari loopback, entri terakhir yang dipakai', ({
        assert,
    }) => {
        const headers = { 'x-forwarded-for': '1.1.1.1, 103.10.20.30' }
        assert.equal(clientIpOf({ address: '127.0.0.1', headers }), '103.10.20.30')
        assert.equal(clientIpOf({ address: '::ffff:127.0.0.1', headers }), '103.10.20.30')
        assert.equal(clientIpOf({ address: '182.1.2.3', headers }), '182.1.2.3')
        assert.equal(clientIpOf({ address: '127.0.0.1', headers: {} }), '127.0.0.1')
        assert.equal(
            clientIpOf({ address: '127.0.0.1', headers: { 'x-forwarded-for': 'bukan-ip' } }),
            '127.0.0.1'
        )
    })

    test('header diteruskan selama masih ada socket dengan token itu', ({ assert }) => {
        rememberClientIp('tok', '103.10.20.30')
        rememberClientIp('tok', '103.10.20.30')
        forgetClientIp('tok')
        assert.equal(userHeaders('tok')['X-Forwarded-For'], '103.10.20.30')
        forgetClientIp('tok')
        assert.notProperty(userHeaders('tok'), 'X-Forwarded-For')
        assert.equal(userHeaders('tok').Authorization, 'Bearer tok')
    })
})
