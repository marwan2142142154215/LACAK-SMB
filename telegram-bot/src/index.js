require('dotenv').config()

const { Bot, run } = require('node-telegram-bot-api/node')
const backend = require('./backendClient')

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
    console.error('TELEGRAM_BOT_TOKEN belum diisi di .env')
    process.exit(1)
}

const bot = new Bot(token)

const NOT_LINKED_MESSAGE =
    'Chat ini belum ditautkan ke site mana pun. Minta admin menautkannya lewat dashboard (menu Bot Telegram).'

/** Bungkus handler supaya chat yang belum ditautkan selalu dapat balasan yang jelas, bukan diam saja. */
function withOrganization(handler) {
    return async (ctx) => {
        const organizationId = await backend.resolveOrganizationId(ctx.chatId)
        if (!organizationId) {
            await ctx.reply(NOT_LINKED_MESSAGE)
            return
        }
        await handler(ctx, organizationId)
    }
}

function formatDeviceLine(device) {
    const statusLabel = {
        online: '🟢 online',
        offline: '⚪ offline',
        locked: '🔴 terkunci',
        pending_enrollment: '🟡 menunggu enrollment',
    }[device.status] ?? device.status

    const battery = device.battery_level != null ? `${device.battery_level}%` : '-'

    return `#${device.id} — ${device.device_name}\n   Status: ${statusLabel} | Baterai: ${battery}`
}

bot.command(
    'start',
    withOrganization(async (ctx, organizationId) => {
        await ctx.reply(
            [
                'Lacak Master — Bot Kontrol',
                `Chat ini terhubung ke site #${organizationId}.`,
                '',
                'Perintah tersedia: /devices /lock /unlock /locate /status /help',
            ].join('\n'),
        )
    }),
)

bot.command('help', async (ctx) => {
    await ctx.reply(
        [
            '/devices — daftar device di site ini',
            '/lock <id> [alasan] — kunci device',
            '/unlock <id> — buka kunci device',
            '/locate <id> — minta lokasi terbaru sekarang',
            '/status <id> — detail status satu device',
        ].join('\n'),
    )
})

bot.command(
    'devices',
    withOrganization(async (ctx, organizationId) => {
        const devices = await backend.listDevices(organizationId)
        if (devices.length === 0) {
            await ctx.reply('Belum ada device terdaftar di site ini.')
            return
        }
        await ctx.reply(devices.map(formatDeviceLine).join('\n\n'))
    }),
)

bot.command(
    'status',
    withOrganization(async (ctx) => {
        const [deviceId] = (ctx.match ?? '').trim().split(/\s+/)
        if (!deviceId) {
            await ctx.reply('Pakai format: /status <id_device>')
            return
        }
        try {
            const device = await backend.getDevice(deviceId)
            const loc = device.latest_location
            const locationText = loc
                ? `Lokasi terakhir: ${loc.source}, jarak BLE ${loc.ble_distance_meters ?? '-'}m, dicatat ${loc.recorded_at}`
                : 'Belum ada data lokasi.'
            await ctx.reply(`${formatDeviceLine(device)}\n${locationText}`)
        } catch {
            await ctx.reply(`Device #${deviceId} tidak ditemukan atau bukan milik site Anda.`)
        }
    }),
)

async function handleCommandAction(ctx, commandType, label) {
    const [deviceId, ...reasonParts] = (ctx.match ?? '').trim().split(/\s+/)
    if (!deviceId) {
        await ctx.reply(`Pakai format: /${label.toLowerCase()} <id_device> [alasan]`)
        return
    }
    try {
        await backend.issueCommand(deviceId, commandType, reasonParts.join(' ') || null)
        await ctx.reply(`Perintah ${label} berhasil dikirim ke device #${deviceId}.`)
    } catch (error) {
        const message = error.response?.data?.message ?? 'Terjadi kesalahan, coba lagi.'
        await ctx.reply(`Gagal: ${message}`)
    }
}

bot.command(
    'lock',
    withOrganization(async (ctx) => handleCommandAction(ctx, 'lock', 'Lock')),
)

bot.command(
    'unlock',
    withOrganization(async (ctx) => handleCommandAction(ctx, 'unlock', 'Unlock')),
)

bot.command(
    'locate',
    withOrganization(async (ctx) => handleCommandAction(ctx, 'locate_now', 'Locate')),
)

bot.catch((err, ctx) => {
    console.error('Bot error:', err)
    ctx.reply('Terjadi kesalahan internal pada bot.').catch(() => {})
})

console.log('Lacak Master Telegram bot berjalan (polling)...')
run(bot)
