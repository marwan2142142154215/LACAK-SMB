import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import {
    cleanCoordinate,
    sanitizeDeviceInfo,
    sanitizeLocationExtras,
    sanitizeLocationReport,
} from '#services/DeviceTelemetry'

test.group('Telemetri device: device:info', () => {
    test('field yang diungkapkan disimpan, field lain diabaikan', ({ assert }) => {
        const info = sanitizeDeviceInfo({
            manufacturer: ' samsung ',
            model: 'SM-A155F',
            androidVersion: '14',
            appVersionName: '1.2.0',
            appVersionCode: 12,
            batteryLevel: 87,
            isCharging: true,
            networkType: 'CELLULAR',
            carrierName: 'Telkomsel',
            storageFreeMb: 20480,
            storageTotalMb: 131072,
            permissions: { location: true, backgroundLocation: false, rahasia: true },
            locationPolicyLocked: true,
            uninstallLocked: true,
            locationServiceOn: true,
            // Data yang TIDAK boleh disimpan walau dikirim APK yang dimodifikasi:
            contacts: ['Budi'],
            smsInbox: ['halo'],
        })
        assert.deepEqual(info, {
            manufacturer: 'samsung',
            model: 'SM-A155F',
            androidVersion: '14',
            appVersionName: '1.2.0',
            appVersionCode: 12,
            batteryLevel: 87,
            isCharging: true,
            networkType: 'cellular',
            carrierName: 'Telkomsel',
            storageFreeMb: 20480,
            storageTotalMb: 131072,
            permissions: { location: true, backgroundLocation: false },
            locationPolicyLocked: true,
            uninstallLocked: true,
            locationServiceOn: true,
        })
        assert.notProperty(info, 'contacts')
        assert.notProperty(info, 'smsInbox')
    })

    test('nilai di luar rentang / tipe salah jadi null, teks dipotong ke panjang kolom', ({
        assert,
    }) => {
        const info = sanitizeDeviceInfo({
            batteryLevel: 140,
            isCharging: 'ya',
            networkType: 'satelit',
            androidVersion: '16.0.0-beta-panjang',
            carrierName: '\u0000\u0007',
            storageFreeMb: -5,
            permissions: ['location'],
            locationPolicyLocked: 'ya',
            uninstallLocked: 1,
        })
        assert.isNull(info.batteryLevel)
        assert.isNull(info.isCharging)
        assert.equal(info.networkType, 'other')
        assert.equal(info.androidVersion, '16.0.0-bet')
        assert.isNull(info.carrierName)
        assert.isNull(info.storageFreeMb)
        assert.isNull(info.permissions)
        // Status kunci bukan boolean (APK dimodifikasi) -> null, tidak dipaksa jadi true/false.
        assert.isNull(info.locationPolicyLocked)
        assert.isNull(info.uninstallLocked)
        assert.isNull(info.locationServiceOn)
        assert.isNull(sanitizeDeviceInfo(null).model)
    })
})

test.group('Telemetri device: lokasi', () => {
    const now = DateTime.fromISO('2026-11-15T10:00:00')

    test('akurasi, sumber, dan waktu fix dibersihkan', ({ assert }) => {
        const extras = sanitizeLocationExtras(
            {
                accuracyMeters: 12.345,
                provider: 'GPS',
                fixTime: now.minus({ minutes: 2 }).toMillis(),
            },
            now
        )
        assert.equal(extras.accuracyMeters, 12.35)
        assert.equal(extras.provider, 'gps')
        assert.equal(extras.fixedAt?.toMillis(), now.minus({ minutes: 2 }).toMillis())
    })

    test('waktu fix yang tidak masuk akal dan sumber asing dibuang', ({ assert }) => {
        const extras = sanitizeLocationExtras(
            {
                accuracyMeters: -1,
                provider: 'wifi-scan',
                fixTime: now.minus({ days: 30 }).toMillis(),
            },
            now
        )
        assert.deepEqual(extras, { accuracyMeters: null, provider: null, fixedAt: null })
    })

    test('koordinat di luar bumi ditolak', ({ assert }) => {
        assert.equal(cleanCoordinate(-6.2, 90), -6.2)
        assert.isNull(cleanCoordinate(91, 90))
        assert.isNull(cleanCoordinate('106.8', 180))
    })
})

test.group('Telemetri device: device:location (selain koordinat)', () => {
    test('nilai normal dari APK lolos apa adanya', ({ assert }) => {
        assert.deepEqual(
            sanitizeLocationReport({
                source: 'ble',
                bleDistanceMeters: 3.5,
                bleRssi: -67,
                batteryLevel: 81,
                ssid: 'Kantor 5G',
                ip: '192.168.1.20',
                nearbyBeaconUuid: 'abc-123',
                nearbyBeaconDistanceMeters: 2,
            }),
            {
                source: 'ble',
                bleDistanceMeters: 3.5,
                bleRssi: -67,
                batteryLevel: 81,
                ssid: 'Kantor 5G',
                ip: '192.168.1.20',
                nearbyBeaconUuid: 'abc-123',
                nearbyBeaconDistanceMeters: 2,
                isMock: null,
            }
        )
    })

    test('isMock: hanya boolean yang diterima; selain itu null', ({ assert }) => {
        assert.isTrue(sanitizeLocationReport({ source: 'gps', isMock: true }).isMock)
        assert.isFalse(sanitizeLocationReport({ source: 'gps', isMock: false }).isMock)
        assert.isNull(sanitizeLocationReport({ source: 'gps' }).isMock)
        assert.isNull(sanitizeLocationReport({ source: 'gps', isMock: 'yes' }).isMock)
    })

    test('sumber di luar daftar jadi null (laporan dibuang pemanggil)', ({ assert }) => {
        assert.isNull(sanitizeLocationReport({ source: 'drop table' }).source)
        assert.isNull(sanitizeLocationReport({}).source)
        assert.isNull(sanitizeLocationReport(null).source)
        assert.equal(sanitizeLocationReport({ source: 'gps' }).source, 'gps')
        assert.equal(sanitizeLocationReport({ source: 'ble_estimated' }).source, 'ble_estimated')
    })

    test('angka di luar rentang kolom atau bukan angka dibuang jadi null', ({ assert }) => {
        const report = sanitizeLocationReport({
            source: 'gps',
            bleDistanceMeters: 1_000_000,
            bleRssi: '-60',
            batteryLevel: 250,
        })
        assert.isNull(report.bleDistanceMeters)
        assert.isNull(report.bleRssi)
        assert.isNull(report.batteryLevel)
        assert.isNull(sanitizeLocationReport({ batteryLevel: Number.NaN }).batteryLevel)
        assert.equal(sanitizeLocationReport({ batteryLevel: 0 }).batteryLevel, 0)
    })

    test('ssid: tidak ada = dipertahankan (undefined), bukan teks diabaikan, teks panjang dipotong', ({
        assert,
    }) => {
        assert.isUndefined(sanitizeLocationReport({}).ssid)
        assert.isUndefined(sanitizeLocationReport({ ssid: 123 }).ssid)
        assert.isUndefined(sanitizeLocationReport({ ssid: { trim: 1 } }).ssid)
        assert.isNull(sanitizeLocationReport({ ssid: null }).ssid)
        assert.equal(sanitizeLocationReport({ ssid: 'x'.repeat(400) }).ssid?.length, 255)
        // Tidak di-trim: dicocokkan apa adanya oleh geofence.
        assert.equal(sanitizeLocationReport({ ssid: ' Kantor ' }).ssid, ' Kantor ')
    })

    test('ip dan uuid beacon: bukan teks jadi null, teks panjang dipotong', ({ assert }) => {
        const report = sanitizeLocationReport({ ip: 42, nearbyBeaconUuid: ['x'] })
        assert.isNull(report.ip)
        assert.isNull(report.nearbyBeaconUuid)
        assert.equal(sanitizeLocationReport({ ip: '1'.repeat(100) }).ip?.length, 45)
    })
})
