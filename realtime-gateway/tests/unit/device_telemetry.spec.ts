import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import {
    cleanCoordinate,
    sanitizeDeviceInfo,
    sanitizeLocationExtras,
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
        })
        assert.isNull(info.batteryLevel)
        assert.isNull(info.isCharging)
        assert.equal(info.networkType, 'other')
        assert.equal(info.androidVersion, '16.0.0-bet')
        assert.isNull(info.carrierName)
        assert.isNull(info.storageFreeMb)
        assert.isNull(info.permissions)
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
