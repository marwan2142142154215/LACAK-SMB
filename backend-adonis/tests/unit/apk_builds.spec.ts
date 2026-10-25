import { test } from '@japa/runner'
import {
    apkBuildResource,
    DEVICE_MORPH,
    downloadFilename,
    guessExtension,
    isConsentActive,
    laravelRandomString,
    laravelSlug,
    phpIntval,
} from '#controllers/apk_builds_controller'
import {
    buildCommand,
    buildScriptPath,
    projectPathFor,
    siteIdentityFor,
    tail,
    toWslPath,
    trimTrailingSlashes,
    type ApkBuilderConfig,
} from '#services/apk_builder'
import { iso8601Now } from '#services/queue'
import { laravelUrlSigner } from '#services/laravel/index'
import { apkFileErrors, toInteger } from '#validators/apk_builds'
import { decodeDeviceSecret, encodeBuildApkPayload } from '#jobs/build_apk_job'
import { crc32b, generateSanctumTokenString } from '../../commands/issue_telegram_bot_token.js'
import { msUntilNextMinute } from '../../commands/scheduler_run.js'

const CONFIG: ApkBuilderConfig = {
    runner: 'wsl',
    trackerProjectPath: 'C:\\Users\\X\\lacak\\android-tracked-app\\',
    masterProjectPath: 'C:/Users/X/lacak/android-master-app',
    liveProjectPath: 'C:/Users/X/lacak/android-live-app',
    serverExePath: 'C:/Users/X/lacak/lacak-server.exe',
    wslDistro: 'Ubuntu',
    publicGatewayUrl: 'https://ws.example.test',
    publicBackendApiUrl: 'https://api.example.test/api/v1',
}

test.group('APK builder: perintah build sama dengan ApkBuilder Laravel', () => {
    test('path Windows diubah ke path WSL', ({ assert }) => {
        assert.equal(
            toWslPath('C:\\Users\\X\\lacak\\foo/scripts/build_only.sh'),
            '/mnt/c/Users/X/lacak/foo/scripts/build_only.sh'
        )
        assert.equal(toWslPath('D:/a b/c'), '/mnt/d/a b/c')
        assert.throws(() => toWslPath('/home/user/app'), 'Path Windows tidak valid: /home/user/app')
    })

    test('rtrim garis miring & pemilihan proyek per tipe', ({ assert }) => {
        assert.equal(trimTrailingSlashes('C:\\a\\b\\/'), 'C:\\a\\b')
        assert.equal(projectPathFor('master', CONFIG), CONFIG.masterProjectPath)
        assert.equal(projectPathFor('live', CONFIG), CONFIG.liveProjectPath)
        assert.equal(projectPathFor('tracker', CONFIG), CONFIG.trackerProjectPath)
    })

    test('APK master & live memakai identitas site universal', ({ assert }) => {
        const org = { unique_site_code: 'SITE-01', name: 'Site Satu' }
        assert.deepEqual(siteIdentityFor('master', org), ['MASTER-UNIVERSAL', 'Lacak SMB'])
        assert.deepEqual(siteIdentityFor('live', org), ['LIVE-UNIVERSAL', 'Lacak SMB'])
        assert.deepEqual(siteIdentityFor('tracker', org), ['SITE-01', 'Site Satu'])
    })

    test('urutan argumen wsl --exec bash sama persis', ({ assert }) => {
        assert.deepEqual(
            buildCommand({
                config: CONFIG,
                scriptPath: '/mnt/c/x/scripts/build_only.sh',
                siteCode: 'SITE-01',
                siteName: 'Site $(rm -rf /)',
                version: '1.2.3',
                deviceUuid: 'uuid-1',
                deviceSecret: 'rahasia',
            }),
            [
                'wsl',
                '-d',
                'Ubuntu',
                '--exec',
                'bash',
                '/mnt/c/x/scripts/build_only.sh',
                'SITE-01',
                'https://ws.example.test',
                'Site $(rm -rf /)',
                '1.2.3',
                'https://api.example.test/api/v1',
                'uuid-1',
                'rahasia',
            ]
        )

        const master = buildCommand({
            config: CONFIG,
            scriptPath: '/x',
            siteCode: 'MASTER-UNIVERSAL',
            siteName: 'Lacak SMB',
            version: '1.0.0',
            deviceUuid: null,
            deviceSecret: null,
        })
        assert.deepEqual(master.slice(-2), ['', ''])
    })

    test('server Linux: skrip dijalankan langsung dengan bash, tanpa WSL', ({ assert }) => {
        const linux: ApkBuilderConfig = {
            ...CONFIG,
            runner: 'bash',
            trackerProjectPath: '/var/www/lacak/android-tracked-app',
        }
        const scriptPath = buildScriptPath(linux.trackerProjectPath, linux)
        assert.equal(scriptPath, '/var/www/lacak/android-tracked-app/scripts/build_only.sh')
        assert.equal(
            buildScriptPath('C:/Users/X/lacak/android-tracked-app', CONFIG),
            '/mnt/c/Users/X/lacak/android-tracked-app/scripts/build_only.sh'
        )

        const command = buildCommand({
            config: linux,
            scriptPath,
            siteCode: 'SITE-01',
            siteName: 'Site $(rm -rf /)',
            version: '1.2.3',
            deviceUuid: null,
            deviceSecret: null,
        })
        assert.deepEqual(command.slice(0, 4), [
            'bash',
            scriptPath,
            'SITE-01',
            'https://ws.example.test',
        ])
        assert.equal(command[4], 'Site $(rm -rf /)')
        assert.notInclude(command, 'wsl')
    })

    test('build_log hanya ekor 5000 karakter (mb_substr)', ({ assert }) => {
        assert.equal(tail('abcdef', 3), 'def')
        assert.equal(tail('abc', 5), 'abc')
        assert.equal(tail('ééé😀', 2), 'é😀')
    })
})

test.group('APK build: resource & unduhan', () => {
    test('morph Device memakai satu backslash', ({ assert }) => {
        assert.equal(DEVICE_MORPH, ['App', 'Models', 'Device'].join(String.fromCharCode(92)))
    })

    test('download_url hanya untuk build sukses dan bertanda tangan valid', ({ assert }) => {
        const now = new Date()
        const base = {
            id: 42,
            organization_id: 3,
            organization_name: 'Site A',
            apk_type: 'tracker',
            version: '1.0.0',
            file_path: 'apk-builds/3/tracker-42.apk',
            embedded_site_code: 'SITE-A',
            checksum_sha256: 'abc',
            build_log: null,
            created_at: new Date('2026-10-25T03:45:45.000Z'),
        }

        const pending = apkBuildResource({ ...base, status: 'pending' }, now)
        assert.isNull(pending.download_url)
        assert.equal(pending.created_at, '2026-10-25T03:45:45.000000Z')
        assert.deepEqual(Object.keys(pending), [
            'id',
            'organization_id',
            'organization_name',
            'apk_type',
            'version',
            'status',
            'embedded_site_code',
            'checksum_sha256',
            'build_log',
            'download_url',
            'created_at',
        ])

        const ok = apkBuildResource({ ...base, status: 'success' }, now)
        const url = new URL(ok.download_url!)
        assert.equal(url.pathname, '/api/v1/apk-builds/42/download')
        assert.isTrue(
            laravelUrlSigner.hasValidSignature(
                url.pathname,
                Object.fromEntries(url.searchParams.entries())
            )
        )
    })

    test('nama berkas unduhan sama dengan ApkBuildController::download', ({ assert }) => {
        assert.equal(
            downloadFilename({ apk_type: 'master', version: '1.0.0', organization_name: 'X' }),
            'smb-admin-v1.0.0.apk'
        )
        assert.equal(
            downloadFilename({ apk_type: 'live', version: '2.0.0', organization_name: null }),
            'smb-live-kerja-v2.0.0.apk'
        )
        assert.equal(
            downloadFilename({
                apk_type: 'tracker',
                version: '1.0.1',
                organization_name: 'Gudang Utama',
            }),
            'smb-pelacak-gudang-utama-v1.0.1.apk'
        )
        assert.equal(
            downloadFilename({ apk_type: 'server', version: '1.0.0', organization_name: null }),
            'lacak-server-site-v1.0.0.exe'
        )
        // Unggahan lama: apk_type null (model create() tanpa refresh) -> label pelacak.
        assert.equal(
            downloadFilename({ apk_type: null, version: '1.0.0', organization_name: 'A' }),
            'smb-pelacak-a-v1.0.0.apk'
        )
    })

    test('Str::slug Laravel', ({ assert }) => {
        assert.equal(laravelSlug('Gudang Utama'), 'gudang-utama')
        assert.equal(laravelSlug('PT. Maju_Jaya  (Cabang 2)'), 'pt-maju-jaya-cabang-2')
        assert.equal(laravelSlug('Café Ünïcode'), 'cafe-unicode')
        assert.equal(laravelSlug('a@b'), 'a-at-b')
        assert.equal(laravelSlug('--Site--'), 'site')
    })

    test('consent aktif: belum dicabut dan valid_until belum lewat', ({ assert }) => {
        const now = new Date('2026-10-25T10:00:00Z')
        assert.isTrue(isConsentActive(null, null, now))
        assert.isTrue(isConsentActive(null, '2026-10-26', now))
        // cast 'date' = pukul 00:00 hari itu -> sudah lewat siang harinya.
        assert.isFalse(isConsentActive(null, '2026-10-25', now))
        assert.isFalse(isConsentActive(new Date(), null, now))
    })

    test('intval PHP, Str::random, dan tebakan ekstensi', ({ assert }) => {
        assert.equal(phpIntval('12'), 12)
        assert.equal(phpIntval(' 7abc'), 7)
        assert.equal(phpIntval('abc'), 0)
        assert.equal(phpIntval(null), 0)
        assert.equal(phpIntval(5.9), 5)
        assert.match(laravelRandomString(40), /^[A-Za-z0-9]{40}$/)
        assert.equal(guessExtension('application/vnd.android.package-archive'), 'apk')
        assert.equal(guessExtension('application/zip'), 'zip')
        assert.equal(guessExtension('application/octet-stream'), 'bin')
    })
})

test.group('APK build: validasi seperti FormRequest Laravel', () => {
    test('rule integer', ({ assert }) => {
        assert.equal(toInteger(5), 5)
        assert.equal(toInteger('5'), 5)
        assert.equal(toInteger('-3'), -3)
        assert.isNull(toInteger('5.5'))
        assert.isNull(toInteger('abc'))
        assert.isNull(toInteger(1.5))
    })

    test('berkas apk_file: wajib, ukuran, ekstensi, MIME', ({ assert }) => {
        assert.deepEqual(apkFileErrors(null), ['The apk file field is required.'])

        const valid = {
            clientExtension: 'APK',
            mimeType: 'application/zip',
            sizeBytes: 1024,
            isValid: true,
        }
        assert.deepEqual(apkFileErrors(valid), [])
        assert.deepEqual(apkFileErrors({ ...valid, mimeType: null }), [])
        assert.deepEqual(apkFileErrors({ ...valid, isValid: false }), [
            'The apk file field must be a file.',
        ])
        assert.deepEqual(apkFileErrors({ ...valid, clientExtension: 'zip' }), [
            'Berkas harus berekstensi .apk',
        ])
        assert.deepEqual(apkFileErrors({ ...valid, mimeType: 'image/png' }), [
            'Berkas APK tidak valid',
        ])
        assert.deepEqual(apkFileErrors({ ...valid, sizeBytes: 204800 * 1024 + 1 }), [
            'The apk file field must not be greater than 204800 kilobytes.',
        ])
    })
})

test.group('APK build: antrean, scheduler, token bot', () => {
    test('rahasia device di payload job terenkripsi dan bisa dibuka worker', ({ assert }) => {
        const payload = encodeBuildApkPayload(7, 'a'.repeat(64))
        assert.equal(payload.apkBuildId, 7)
        assert.notInclude(payload.deviceSecret!, 'aaaa')
        assert.equal(decodeDeviceSecret(payload), 'a'.repeat(64))

        assert.deepEqual(encodeBuildApkPayload(8, null), { apkBuildId: 8, deviceSecret: null })
        assert.isNull(decodeDeviceSecret({ apkBuildId: 8, deviceSecret: null }))
    })

    test('detak memakai format toIso8601String Carbon', ({ assert }) => {
        assert.equal(iso8601Now(new Date('2026-10-25T03:45:45.123Z')), '2026-10-25T03:45:45+00:00')
    })

    test('scheduler jalan tepat di awal menit', ({ assert }) => {
        assert.equal(msUntilNextMinute(new Date('2026-10-25T03:45:45.000Z')), 15_000)
        assert.equal(msUntilNextMinute(new Date('2026-10-25T03:45:00.000Z')), 60_000)
    })

    test('token Sanctum: 40 karakter acak + crc32b', ({ assert }) => {
        // hash('crc32b', 'The quick brown fox jumps over the lazy dog') di PHP.
        assert.equal(crc32b('The quick brown fox jumps over the lazy dog'), '414fa339')

        const token = generateSanctumTokenString()
        assert.match(token, /^[A-Za-z0-9]{40}[0-9a-f]{8}$/)
        assert.equal(token.slice(40), crc32b(token.slice(0, 40)))
        assert.isTrue(generateSanctumTokenString('lacak_').startsWith('lacak_'))
    })
})
