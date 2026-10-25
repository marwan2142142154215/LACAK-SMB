import { assert } from '@japa/assert'
import { apiClient } from '@japa/api-client'
import app from '@adonisjs/core/services/app'
import type { Config } from '@japa/runner/types'
import { pluginAdonisJS } from '@japa/plugin-adonisjs'
import testUtils from '@adonisjs/core/services/test_utils'

/**
 * Tes fungsional memakai database tes yang SAMA dengan backend-api
 * (lacak_master_test, skemanya dari migrasi Laravel: `php artisan migrate
 * --env=testing`). Tiap tes dibungkus transaksi global lalu di-rollback.
 */
export const plugins: Config['plugins'] = [assert(), pluginAdonisJS(app), apiClient()]

export const runnerHooks: Required<Pick<Config, 'setup' | 'teardown'>> = {
    setup: [],
    teardown: [],
}

export const configureSuite: Config['configureSuite'] = (suite) => {
    if (suite.name === 'functional') {
        return suite.setup(() => testUtils.httpServer().start())
    }
}
