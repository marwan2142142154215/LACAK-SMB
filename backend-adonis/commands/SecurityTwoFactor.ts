import { args, BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { isTwoFactorRequired, setTwoFactorRequired } from '#services/two_factor_policy'

/**
 * Menyalakan/mematikan kewajiban 2FA dari server (padanan
 * SetTwoFactorRequirement) -- untuk server uji, atau saat super_admin
 * terkunci dan tidak bisa membuka halaman Pengaturan.
 */
export default class SetTwoFactorRequirement extends BaseCommand {
    static commandName = 'security:two-factor'
    static description = 'Lihat atau ubah apakah 2FA wajib saat login'

    static options: CommandOptions = {
        startApp: true,
    }

    @args.string({
        description: 'on = wajib 2FA, off = login cukup password',
        required: false,
    })
    declare state?: string

    async run() {
        if (this.state === undefined) {
            const required = await isTwoFactorRequired()
            this.logger.log(`2FA saat login: ${required ? 'WAJIB (on)' : 'TIDAK wajib (off)'}`)
            return
        }

        if (this.state !== 'on' && this.state !== 'off') {
            this.logger.error('Isi dengan "on" atau "off".')
            this.exitCode = 1
            return
        }

        await setTwoFactorRequired(this.state === 'on', null)

        this.logger.info(
            this.state === 'on'
                ? '2FA sekarang WAJIB saat login.'
                : '2FA dimatikan: login cukup username/email + password. Jangan pakai mode ini di server produksi.'
        )
    }
}
