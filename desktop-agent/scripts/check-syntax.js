'use strict'

// Cek sintaks main-process files tanpa menjalankan Electron (`node --check`
// hanya mem-parse, tidak mengeksekusi `require('electron')`). Jendela renderer
// (HTML + script inline) tidak ikut; diuji saat aplikasi dijalankan di Windows.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const files = ['src/main.js', 'src/preload.js', 'src/config.js', 'src/auth.js', 'src/reporter.js']
const root = path.join(__dirname, '..')

let failed = false
for (const file of files) {
    try {
        execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' })
        console.log('ok   ', file)
    } catch (error) {
        failed = true
        console.error('FAIL ', file)
        console.error(error.stderr?.toString() || error.message)
    }
}
process.exit(failed ? 1 : 0)
