import { assert } from '@japa/assert'
import { apiClient } from '@japa/api-client'
import app from '@adonisjs/core/services/app'
import type { Config } from '@japa/runner/types'
import { pluginAdonisJS } from '@japa/plugin-adonisjs'
import testUtils from '@adonisjs/core/services/test_utils'
import { clearAppRedisKeys, seedRolesAndPermissions } from '#tests/helpers/setup'

/**
 * Tes fungsional memakai database tes (lacak_master_test). Skemanya dibuat
 * migrasi Lucid sebelum tes jalan (database kosong = dari skema dasar).
 */
export const plugins: Config['plugins'] = [assert(), pluginAdonisJS(app), apiClient()]

export const runnerHooks: Required<Pick<Config, 'setup' | 'teardown'>> = {
    // Tanpa rollback setelah tes: skema dasar tidak bisa dibongkar.
    setup: [
        async () => {
            await testUtils.db().migrate()
        },
    ],
    teardown: [],
}

export const configureSuite: Config['configureSuite'] = (suite) => {
    if (suite.name === 'functional') {
        // Peran & izin dibuat sekali; kunci Redis aplikasi dikosongkan sebelum
        // TIAP tes (rate limit, token 2FA) -- lihat tests/helpers/setup.ts.
        suite.setup(() => seedRolesAndPermissions())
        suite.onGroup((group) => group.each.setup(() => clearAppRedisKeys()))
        suite.onTest((test) => test.setup(() => clearAppRedisKeys()))
        return suite.setup(() => testUtils.httpServer().start())
    }
}
