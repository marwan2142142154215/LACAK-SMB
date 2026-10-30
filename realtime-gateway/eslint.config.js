import { configApp } from '@adonisjs/eslint-config'

export default configApp({
    rules: {
        // File aplikasi memakai PascalCase; config/start/tests tetap snake_case.
        '@unicorn/filename-case': ['error', { cases: { pascalCase: true, snakeCase: true } }],
    },
})
