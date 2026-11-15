import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
    commandStatusMeta,
    isCommandOpen,
    isStorageLow,
    locationQualityLabel,
    missingPermissions,
    modelLabel,
    networkLabel,
    storageLabel,
} from './deviceInfo.js'

test('status perintah punya label & varian; status asing tidak membuat crash', () => {
    assert.deepEqual(commandStatusMeta('executed'), { label: 'Dijalankan', variant: 'success' })
    assert.equal(commandStatusMeta('failed').variant, 'danger')
    assert.equal(commandStatusMeta('aneh').label, 'aneh')
    assert.equal(isCommandOpen('acknowledged'), true)
    assert.equal(isCommandOpen('expired'), false)
})

test('izin wajib yang belum diberikan; Device Owner menutupi admin & overlay', () => {
    assert.equal(missingPermissions(null), null)
    assert.deepEqual(
        missingPermissions({ location: true, backgroundLocation: false, overlay: false, bluetooth: false }),
        ['Lokasi sepanjang waktu', 'Tampil di atas aplikasi lain'],
    )
    assert.deepEqual(missingPermissions({ deviceOwner: true, deviceAdmin: false, overlay: false }), [])
})

test('label jaringan, model, penyimpanan', () => {
    assert.equal(networkLabel({ network_type: 'cellular', carrier_name: 'Telkomsel' }), 'Seluler · Telkomsel')
    assert.equal(networkLabel({ network_type: 'wifi', last_ssid: 'Kantor' }), 'WiFi · Kantor')
    assert.equal(networkLabel({ last_ssid: 'Kantor' }), 'WiFi · Kantor')
    assert.equal(networkLabel({}), null)

    assert.equal(modelLabel({ manufacturer: 'samsung', model: 'SM-A155F' }), 'samsung SM-A155F')
    assert.equal(modelLabel({ manufacturer: 'Xiaomi', model: 'Xiaomi 13' }), 'Xiaomi 13')
    assert.equal(modelLabel({}), null)

    assert.equal(storageLabel({ storage_free_mb: 512, storage_total_mb: 65536 }), 'Sisa 512 MB dari 64 GB')
    assert.equal(isStorageLow({ storage_free_mb: 512, storage_total_mb: 65536 }), true)
    assert.equal(isStorageLow({ storage_free_mb: 20480, storage_total_mb: 65536 }), false)
    assert.equal(isStorageLow({}), false)
})

test('kualitas lokasi', () => {
    assert.equal(locationQualityLabel({ location_provider: 'gps', accuracy_meters: '12.40' }), 'GPS · ±12 m')
    assert.equal(locationQualityLabel({ location_provider: null, accuracy_meters: null }), null)
})
