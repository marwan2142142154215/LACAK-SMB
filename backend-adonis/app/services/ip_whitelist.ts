import { BlockList, isIP } from 'node:net'
import type { HttpContext } from '@adonisjs/core/http'
import { roleNamesOf } from '#services/permissions'
import { getSetting, putSetting } from '#services/two_factor_policy'

/**
 * Whitelist IP global: kalau aktif, semua akun hanya bisa login & memakai API
 * (dashboard, APK Master, APK Live Kerja, chat lewat gateway) dari alamat IP
 * di daftar. Dicek saat login DAN di setiap request terautentikasi, jadi sesi
 * yang sudah jalan ikut terputus begitu pindah ke jaringan lain.
 *
 * Dikecualikan: super_admin (supaya pengelola tidak bisa mengunci dirinya
 * sendiri & selalu bisa memperbaiki daftar) dan akun layanan bot Telegram
 * (memanggil API dari server bot, bukan dari jaringan kantor).
 *
 * IP klien diambil dari ctx.request.ip(): di belakang nginx/gateway di
 * server yang sama, X-Forwarded-For dari loopback dipercaya (trustProxy
 * bawaan Adonis), dari alamat lain tidak.
 */
export const IP_WHITELIST_SETTING_KEY = 'security.ip_whitelist'
export const MAX_ENTRIES = 200
export const IP_NOT_ALLOWED = 'ip_not_allowed'

const EXEMPT_ROLES = ['super_admin', 'telegram_bot_service']
const CACHE_MS = 10_000

export type IpWhitelistEntry = { value: string; label: string }
export type IpWhitelist = { enabled: boolean; entries: IpWhitelistEntry[] }

let cache: { at: number; list: IpWhitelist; blockList: BlockList } | null = null

export async function getIpWhitelist(): Promise<IpWhitelist> {
    const { list } = await loaded()
    return list
}

/**
 * @param changedByUserId pelaku (null = dari perintah konsol security:ip-whitelist).
 */
export async function setIpWhitelist(
    list: IpWhitelist,
    changedByUserId: number | null,
    ctx: HttpContext | null = null
): Promise<void> {
    await putSetting(IP_WHITELIST_SETTING_KEY, list, changedByUserId, ctx)
    cache = null
}

/** Buang cache (tes yang membatalkan transaksi, atau perubahan langsung di DB). */
export function forgetIpWhitelistCache() {
    cache = null
}

/** '::ffff:10.0.0.5' (IPv4 di soket IPv6) -> '10.0.0.5'. */
export function normalizeIp(ip: string): string {
    const trimmed = ip.trim()
    const mapped = trimmed.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
    return mapped ? mapped[1] : trimmed
}

/**
 * Bentuk baku satu entri ('10.0.0.5', '10.0.0.0/24', '2001:db8::/32'), atau
 * null kalau bukan alamat/CIDR yang sah.
 */
export function normalizeEntry(value: string): string | null {
    const [address, prefix, ...rest] = value.trim().split('/')
    if (rest.length) return null
    const ip = normalizeIp(address ?? '')
    const family = isIP(ip)
    if (!family) return null
    if (prefix === undefined) return ip
    if (!/^\d{1,3}$/.test(prefix)) return null
    const bits = Number(prefix)
    if (bits > (family === 4 ? 32 : 128)) return null
    return `${ip}/${bits}`
}

export function buildBlockList(entries: IpWhitelistEntry[]): BlockList {
    const blockList = new BlockList()
    for (const { value } of entries) {
        const normalized = normalizeEntry(value)
        if (!normalized) continue
        const [address, prefix] = normalized.split('/')
        const type = isIP(address) === 4 ? 'ipv4' : 'ipv6'
        if (prefix === undefined) blockList.addAddress(address, type)
        else blockList.addSubnet(address, Number(prefix), type)
    }
    return blockList
}

export function ipMatches(blockList: BlockList, ip: string): boolean {
    const address = normalizeIp(ip)
    const family = isIP(address)
    if (!family) return false
    return blockList.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

/**
 * Boleh/tidaknya IP ini secara umum (whitelist mati atau IP terdaftar), tanpa
 * pengecualian peran -- dipakai halaman depan dashboard sebelum login.
 */
export async function isIpAllowed(ip: string): Promise<boolean> {
    const { list, blockList } = await loaded()
    if (!list.enabled || list.entries.length === 0) return true
    return ipMatches(blockList, ip)
}

/**
 * Pesan penolakan kalau user ini tidak boleh mengakses dari IP request ini,
 * atau null kalau boleh (whitelist mati, IP terdaftar, atau peran dikecualikan).
 */
export async function ipRejectionFor(ctx: HttpContext, userId: number): Promise<string | null> {
    const { list, blockList } = await loaded()
    if (!list.enabled || list.entries.length === 0) return null

    const ip = normalizeIp(ctx.request.ip())
    if (ipMatches(blockList, ip)) return null

    const roles = await roleNamesOf(userId)
    if (roles.some((role) => EXEMPT_ROLES.includes(role))) return null

    return `Akses hanya diizinkan dari jaringan yang terdaftar. IP Anda (${ip}) tidak ada di whitelist -- hubungi super admin.`
}

/** Jawaban 403 seragam untuk login & request terautentikasi. */
export function ipRejectionBody(message: string, ctx: HttpContext) {
    return {
        success: false,
        message,
        errors: { reason: IP_NOT_ALLOWED, ip: normalizeIp(ctx.request.ip()) },
    }
}

async function loaded() {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache
    const list = parse(await getSetting(IP_WHITELIST_SETTING_KEY, null))
    cache = { at: Date.now(), list, blockList: buildBlockList(list.entries) }
    return cache
}

function parse(raw: unknown): IpWhitelist {
    if (!raw || typeof raw !== 'object') return { enabled: false, entries: [] }
    const data = raw as { enabled?: unknown; entries?: unknown }
    const entries = Array.isArray(data.entries)
        ? data.entries
              .map((entry) => ({
                  value: String((entry as IpWhitelistEntry)?.value ?? ''),
                  label: String((entry as IpWhitelistEntry)?.label ?? ''),
              }))
              .filter((entry) => normalizeEntry(entry.value) !== null)
        : []
    return { enabled: data.enabled === true, entries }
}
