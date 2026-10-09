import { Bot, InputFile, type Context } from 'node-telegram-bot-api/node'
import type { Logger } from '@adonisjs/core/logger'
import * as backend from '#services/backend_api_client'
import type { Device } from '#services/backend_api_client'

const NOT_LINKED_MESSAGE =
    'Chat ini belum ditautkan ke site mana pun. Minta admin menautkannya lewat dashboard (menu Bot Telegram).'

const APK_POLL_INTERVAL_MS = 5_000
// ~3 menit: cukup untuk build normal (1-2 menit) tanpa membuat operator menunggu tanpa batas.
const APK_POLL_MAX_TRIES = 36

type OrganizationHandler = (ctx: Context, chatId: number, organizationId: number) => Promise<void>

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function commandArgs(ctx: Context): string {
    return typeof ctx.match === 'string' ? ctx.match.trim() : ''
}

function formatDeviceLine(device: Device) {
    const statusLabels: Record<string, string> = {
        online: '🟢 online',
        offline: '⚪ offline',
        locked: '🔴 terkunci',
        pending_enrollment: '🟡 menunggu enrollment',
    }
    const statusLabel = statusLabels[device.status] ?? device.status
    const battery = device.battery_level !== null ? `${device.battery_level}%` : '-'

    return `#${device.id} — ${device.device_name}\n   Status: ${statusLabel} | Baterai: ${battery}`
}

/**
 * Ambil device atas nama chat dan pastikan milik site chat tersebut.
 * Backend juga menolak device site lain (header X-Telegram-Chat-Id); cek
 * organization_id di sini menjaga pesan ke operator tetap konsisten.
 * Hanya 403/404 yang berarti "tidak ditemukan / bukan milik site Anda" --
 * galat lain (backend mati, timeout) harus muncul sebagai galat, bukan
 * disamarkan menjadi "tidak ditemukan".
 */
async function findOwnedDevice(
    chatId: number,
    deviceId: string,
    organizationId: number
): Promise<Device | null> {
    let device: Device
    try {
        device = await backend.getDevice(chatId, deviceId)
    } catch (error) {
        const status = backend.responseStatusOf(error)
        if (status === 403 || status === 404) return null
        throw error
    }
    return device.organization_id === organizationId ? device : null
}

export function createTelegramBot(token: string, logger: Logger): Bot {
    const bot = new Bot(token)

    /** Bungkus handler supaya chat yang belum ditautkan selalu dapat balasan yang jelas, bukan diam saja. */
    function withOrganization(handler: OrganizationHandler) {
        return async (ctx: Context) => {
            const chatId = ctx.chatId
            if (chatId === undefined) {
                throw new Error('Update perintah tanpa chat id')
            }
            const organizationId = await backend.resolveOrganizationId(chatId)
            if (!organizationId) {
                await ctx.reply(NOT_LINKED_MESSAGE)
                return
            }
            await handler(ctx, chatId, organizationId)
        }
    }

    async function handleCommandAction(
        ctx: Context,
        chatId: number,
        organizationId: number,
        commandType: string,
        label: string
    ) {
        const [deviceId, ...reasonParts] = commandArgs(ctx).split(/\s+/)
        if (!/^\d+$/.test(deviceId ?? '')) {
            await ctx.reply(`Pakai format: /${label.toLowerCase()} <id_device> [alasan]`)
            return
        }
        try {
            const device = await findOwnedDevice(chatId, deviceId, organizationId)
            if (!device) {
                await ctx.reply(`Device #${deviceId} tidak ditemukan atau bukan milik site Anda.`)
                return
            }
            await backend.issueCommand(chatId, deviceId, commandType, reasonParts.join(' ') || null)
            await ctx.reply(`Perintah ${label} berhasil dikirim ke device #${deviceId}.`)
        } catch (error) {
            logger.error(
                { error: backend.describeError(error), commandType },
                'Perintah device gagal'
            )
            await ctx.reply(`Gagal: ${backend.backendErrorMessage(error)}`)
        }
    }

    bot.command(
        'start',
        withOrganization(async (ctx, _chatId, organizationId) => {
            await ctx.reply(
                [
                    'Lacak Master — Bot Kontrol',
                    `Chat ini terhubung ke site #${organizationId}.`,
                    '',
                    'Perintah tersedia: /devices /lock /unlock /locate /status /help',
                ].join('\n')
            )
        })
    )

    bot.command('help', async (ctx) => {
        await ctx.reply(
            [
                '/devices — daftar device di site ini',
                '/lock <id> [alasan] — kunci device',
                '/unlock <id> — buka kunci device',
                '/locate <id> — minta lokasi terbaru sekarang',
                '/status <id> — detail status satu device',
                '/apk [tracker|master|server] - build & kirim artefak untuk site ini (default: tracker)',
            ].join('\n')
        )
    })

    bot.command(
        'apk',
        withOrganization(async (ctx, chatId, organizationId) => {
            const requested = commandArgs(ctx).toLowerCase()
            const apkType =
                requested === 'master' ? 'master' : requested === 'server' ? 'server' : 'tracker'
            const label =
                apkType === 'master'
                    ? 'APK Master'
                    : apkType === 'server'
                      ? 'Server Controller'
                      : 'APK Pelacak'

            let build
            try {
                build = await backend.generateApkBuild(chatId, organizationId, apkType, '1.0.0')
            } catch (error) {
                logger.error(
                    { error: backend.describeError(error), apkType },
                    'Gagal memulai build APK'
                )
                await ctx.reply(
                    `Gagal memulai build ${label}: ${backend.backendErrorMessage(error)}`
                )
                return
            }

            await ctx.reply(
                `Build ${label} dimulai untuk site ini (kode ${build.embedded_site_code}). Biasanya selesai 1-2 menit, saya kirim file-nya ke sini begitu jadi...`
            )

            for (let attempt = 0; attempt < APK_POLL_MAX_TRIES; attempt += 1) {
                await sleep(APK_POLL_INTERVAL_MS)

                let current
                try {
                    current = await backend.getApkBuild(chatId, build.id)
                } catch (error) {
                    // Satu kali polling gagal (mis. timeout sesaat) belum berarti build gagal,
                    // jadi dicatat lalu dicoba lagi pada putaran berikutnya.
                    logger.warn(
                        { error: backend.describeError(error), buildId: build.id, attempt },
                        'Gagal mengecek status build APK, dicoba lagi'
                    )
                    continue
                }

                if (current.status === 'success') {
                    let fileBytes
                    try {
                        fileBytes = await backend.downloadBuildFile(current.download_url)
                    } catch (error) {
                        logger.error(
                            { error: backend.describeError(error), buildId: build.id },
                            'Gagal mengunduh berkas build APK'
                        )
                        await ctx.reply(
                            `Build ${label} selesai, tetapi berkasnya gagal diambil. Unduh lewat dashboard (menu APK Builds).`
                        )
                        return
                    }
                    const extension = apkType === 'server' ? 'exe' : 'apk'
                    await bot.api.sendDocument({
                        chat_id: chatId,
                        document: new InputFile(fileBytes, {
                            filename: `lacak-${apkType}-${current.embedded_site_code}-v${current.version}.${extension}`,
                        }),
                        caption: `${label} v${current.version} — site ${current.embedded_site_code}`,
                    })
                    return
                }

                if (current.status === 'failed') {
                    const logTail = (current.build_log ?? '').slice(-500)
                    await ctx.reply(
                        `Build ${label} gagal.\n\n${logTail || 'Tidak ada detail error.'}`
                    )
                    return
                }
            }

            await ctx.reply(
                `Build ${label} masih berjalan setelah ${(APK_POLL_MAX_TRIES * APK_POLL_INTERVAL_MS) / 1000}s — cek lagi lewat dashboard (menu APK Builds).`
            )
        })
    )

    bot.command(
        'devices',
        withOrganization(async (ctx, chatId, organizationId) => {
            const devices = await backend.listDevices(chatId, organizationId)
            if (devices.length === 0) {
                await ctx.reply('Belum ada device terdaftar di site ini.')
                return
            }
            await ctx.reply(devices.map(formatDeviceLine).join('\n\n'))
        })
    )

    bot.command(
        'status',
        withOrganization(async (ctx, chatId, organizationId) => {
            const [deviceId] = commandArgs(ctx).split(/\s+/)
            if (!/^\d+$/.test(deviceId ?? '')) {
                await ctx.reply('Pakai format: /status <id_device>')
                return
            }
            try {
                const device = await findOwnedDevice(chatId, deviceId, organizationId)
                if (!device) {
                    await ctx.reply(
                        `Device #${deviceId} tidak ditemukan atau bukan milik site Anda.`
                    )
                    return
                }
                const loc = device.latest_location
                const locationText = loc
                    ? `Lokasi terakhir: ${loc.source}, jarak BLE ${loc.ble_distance_meters ?? '-'}m, dicatat ${loc.recorded_at}`
                    : 'Belum ada data lokasi.'
                await ctx.reply(`${formatDeviceLine(device)}\n${locationText}`)
            } catch (error) {
                logger.error(
                    { error: backend.describeError(error) },
                    'Gagal mengambil status device'
                )
                await ctx.reply(`Gagal: ${backend.backendErrorMessage(error)}`)
            }
        })
    )

    bot.command(
        'lock',
        withOrganization((ctx, chatId, organizationId) =>
            handleCommandAction(ctx, chatId, organizationId, 'lock', 'Lock')
        )
    )

    bot.command(
        'unlock',
        withOrganization((ctx, chatId, organizationId) =>
            handleCommandAction(ctx, chatId, organizationId, 'unlock', 'Unlock')
        )
    )

    bot.command(
        'locate',
        withOrganization((ctx, chatId, organizationId) =>
            handleCommandAction(ctx, chatId, organizationId, 'locate_now', 'Locate')
        )
    )

    bot.catch(async (error, ctx) => {
        logger.error(
            { error: backend.describeError(error), updateId: ctx.update.update_id },
            'Handler bot gagal'
        )
        try {
            await ctx.reply('Terjadi kesalahan internal pada bot.')
        } catch (replyError) {
            logger.error(
                { error: backend.describeError(replyError), updateId: ctx.update.update_id },
                'Gagal mengirim pesan kesalahan ke chat'
            )
        }
    })

    return bot
}
