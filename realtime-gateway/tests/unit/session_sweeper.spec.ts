import { test } from '@japa/runner'
import { tokenIdOf } from '#services/session_sweeper'

test.group('Pemeriksaan sesi socket', () => {
    test('id token Sanctum dibaca dari "{id}|{plain}"', ({ assert }) => {
        assert.equal(tokenIdOf('42|abcdef'), 42)
        assert.isNull(tokenIdOf('abcdef'))
        assert.isNull(tokenIdOf('42|'))
        assert.isNull(tokenIdOf(undefined))
        assert.isNull(tokenIdOf(42))
    })
})
