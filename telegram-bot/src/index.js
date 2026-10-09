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
            '/apk [tracker|master|server] - build & kirim artefak untuk site ini (default: tracker)',
        ].join('\n'),
    )
})

const APK_POLL_INTERVAL_MS = 5_000
const APK_POLL_MAX_TRIES = 36 // ~3 menit

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

bot.command(
    'apk',
    withOrganization(async (ctx, organizationId) => {
        const requested = (ctx.match ?? '').trim().toLowerCase()
        const apkType = requested === 'master' ? 'master' : (requested === 'server' ? 'server' : 'tracker')
        const label = apkType === 'master' ? 'APK Master' : (apkType === 'server' ? 'Server Controller' : 'APK Pelacak')

        let build
        try {
            build = await backend.generateApkBuild(organizationId, apkType, '1.0.0')
        } catch (error) {
            const message = error.response?.data?.message ?? 'Terjadi kesalahan, coba lagi.'
            await ctx.reply(`Gagal memulai build ${label}: ${message}`)
            return
        }

        await ctx.reply(
            `Build ${label} dimulai untuk site ini (kode ${build.embedded_site_code}). Biasanya selesai 1-2 menit, saya kirim file-nya ke sini begitu jadi...`,
        )

        for (let attempt = 0; attempt < APK_POLL_MAX_TRIES; attempt += 1) {
            await sleep(APK_POLL_INTERVAL_MS)

            let current
            try {
                current = await backend.getApkBuild(build.id)
            } catch {
                continue
            }

            if (current.status === 'success') {
                await bot.api.sendDocument({
                    chat_id: ctx.chatId,
                    document: current.download_url,
                    caption: `${label} v${current.version} — site ${current.embedded_site_code}`,
                })
                return
            }

            if (current.status === 'failed') {
                const logTail = (current.build_log ?? '').slice(-500)
                await ctx.reply(`Build ${label} gagal.\n\n${logTail || 'Tidak ada detail error.'}`)
                return
            }
        }

        await ctx.reply(`Build ${label} masih berjalan setelah ${(APK_POLL_MAX_TRIES * APK_POLL_INTERVAL_MS) / 1000}s — cek lagi lewat dashboard (menu APK Builds).`)
    }),
)

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

// Token akun layanan bot ini sengaja lintas-organisasi penuh di backend
// (lihat ResolvesOrganizationScope::hasCrossOrganizationAccess) -- satu bot
// token melayani banyak chat yang masing-masing terikat ke site berbeda,
// dan desain itu MEMANG mengandalkan bot sendiri yang mencocokkan device ke
// organization_id chat sebelum bertindak (dicatat eksplisit di komentar
// trait itu). Sebelumnya pencocokan ini tidak pernah benar-benar dilakukan
// -- device ID tinggal diketik manual, jadi siapa pun di satu grup Telegram
// bisa lock/unlock/lihat status device MILIK SITE LAIN. assertDeviceInOrg
// menutup celah itu: ambil device dulu, tolak kalau organization_id-nya
// tidak cocok dengan organisasi chat ini.
async function assertDeviceInOrg(deviceId, organizationId) {
    const device = await backend.getDevice(deviceId)
    if (device.organization_id !== organizationId) {
        const err = new Error('Device bukan milik site ini')
        err.isWrongOrg = true
        throw err
    }
    return device
}

bot.command(
    'status',
    withOrganization(async (ctx, organizationId) => {
        const [deviceId] = (ctx.match ?? '').trim().split(/\s+/)
        if (!deviceId) {
            await ctx.reply('Pakai format: /status <id_device>')
            return
        }
        try {
            const device = await assertDeviceInOrg(deviceId, organizationId)
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

async function handleCommandAction(ctx, organizationId, commandType, label) {
    const [deviceId, ...reasonParts] = (ctx.match ?? '').trim().split(/\s+/)
    if (!deviceId) {
        await ctx.reply(`Pakai format: /${label.toLowerCase()} <id_device> [alasan]`)
        return
    }
    try {
        await assertDeviceInOrg(deviceId, organizationId)
        await backend.issueCommand(deviceId, commandType, reasonParts.join(' ') || null)
        await ctx.reply(`Perintah ${label} berhasil dikirim ke device #${deviceId}.`)
    } catch (error) {
        if (error.isWrongOrg) {
            await ctx.reply(`Device #${deviceId} tidak ditemukan atau bukan milik site Anda.`)
            return
        }
        const message = error.response?.data?.message ?? 'Terjadi kesalahan, coba lagi.'
        await ctx.reply(`Gagal: ${message}`)
    }
}

bot.command(
    'lock',
    withOrganization(async (ctx, organizationId) => handleCommandAction(ctx, organizationId, 'lock', 'Lock')),
)

bot.command(
    'unlock',
    withOrganization(async (ctx, organizationId) => handleCommandAction(ctx, organizationId, 'unlock', 'Unlock')),
)

bot.command(
    'locate',
    withOrganization(async (ctx, organizationId) => handleCommandAction(ctx, organizationId, 'locate_now', 'Locate')),
)

bot.catch((err, ctx) => {
    console.error('Bot error:', err)
    ctx.reply('Terjadi kesalahan internal pada bot.').catch(() => {})
})

console.log('Lacak Master Telegram bot berjalan (polling)...')
run(bot)
