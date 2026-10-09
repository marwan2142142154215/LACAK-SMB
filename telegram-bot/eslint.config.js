const js = require('@eslint/js')

module.exports = [
    { ignores: ['node_modules/**'] },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {
                require: 'readonly',
                module: 'readonly',
                process: 'readonly',
                console: 'readonly',
                setTimeout: 'readonly',
            },
        },
    },
]
