import { test } from '@japa/runner'
import { repositoryRoot } from '#services/ApkBuilder'

test.group('Build APK: akar repositori', () => {
    test('produksi (dari folder build) naik DUA tingkat ke akar repositori', ({ assert }) => {
        assert.equal(
            repositoryRoot('/home/smbapps/lacaklive/backend-adonis/build'),
            '/home/smbapps/lacaklive'
        )
        assert.equal(
            repositoryRoot('/home/smbapps/lacaklive/backend-adonis/build/'),
            '/home/smbapps/lacaklive'
        )
    })

    test('pengembangan (dari backend-adonis) naik satu tingkat', ({ assert }) => {
        assert.equal(repositoryRoot('/home/dev/lacaklive/backend-adonis'), '/home/dev/lacaklive')
    })

    test('path Windows memakai pemisah /', ({ assert }) => {
        assert.equal(
            repositoryRoot(String.raw`D:\WSP\GITHUB\lacaklive\backend-adonis`),
            'D:/WSP/GITHUB/lacaklive'
        )
    })
})
