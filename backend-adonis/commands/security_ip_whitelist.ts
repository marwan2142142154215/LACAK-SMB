import { args, BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { getIpWhitelist, normalizeEntry, setIpWhitelist } from '#services/ip_whitelist'

/**
 * Jalan darurat whitelist IP dari server: halaman login dashboard tidak
 * tampil dari IP yang tidak terdaftar, jadi kalau IP kantor berubah, super
 * admin memperbaikinya dari sini.
 *
 *   node ace security:ip-whitelist              -> lihat status & daftar
 *   node ace security:ip-whitelist off          -> matikan whitelist
 *   node ace security:ip-whitelist on           -> nyalakan (daftar tidak boleh kosong)
 *   node ace security:ip-whitelist add 1.2.3.4  -> tambah IP/CIDR ke daftar
 */
export default class SecurityIpWhitelist extends BaseCommand {
    static commandName = 'security:ip-whitelist'
    static description = 'Lihat, nyalakan/matikan, atau tambah IP di whitelist IP'

    static options: CommandOptions = {
        startApp: true,
    }

    @args.string({ description: 'on | off | add', required: false })
    declare action?: string

    @args.string({ description: 'IP atau CIDR (untuk add)', required: false })
    declare value?: string

    async run() {
        const list = await getIpWhitelist()

        if (this.action === undefined) {
            this.logger.log(`Whitelist IP: ${list.enabled ? 'AKTIF (on)' : 'MATI (off)'}`)
            for (const entry of list.entries) {
                this.logger.log(`  ${entry.value}${entry.label ? `  (${entry.label})` : ''}`)
            }
            if (!list.entries.length) this.logger.log('  (daftar kosong)')
            return
        }

        if (this.action === 'off' || this.action === 'on') {
            const enabled = this.action === 'on'
            if (enabled && !list.entries.length) {
                this.logger.error('Daftar masih kosong -- tambahkan IP dulu dengan "add".')
                this.exitCode = 1
                return
            }
            await setIpWhitelist({ ...list, enabled }, null)
            this.logger.info(
                enabled
                    ? `Whitelist IP AKTIF: ${list.entries.length} IP/rentang diizinkan.`
                    : 'Whitelist IP dimatikan: login dari IP mana saja.'
            )
            return
        }

        if (this.action === 'add') {
            const value = normalizeEntry(this.value ?? '')
            if (!value) {
                this.logger.error('Isi IP (mis. 103.10.20.30) atau CIDR (mis. 192.168.1.0/24).')
                this.exitCode = 1
                return
            }
            if (!list.entries.some((entry) => entry.value === value)) {
                list.entries.push({ value, label: 'Ditambah dari server' })
            }
            await setIpWhitelist(list, null)
            this.logger.info(`${value} ada di whitelist (${list.entries.length} IP/rentang).`)
            return
        }

        this.logger.error('Isi dengan "on", "off", atau "add <ip>".')
        this.exitCode = 1
    }
}
