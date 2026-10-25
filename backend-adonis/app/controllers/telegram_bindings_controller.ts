import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { accessOf, can } from '#services/access'
import { fail, success } from '#services/api_response'
import { laravelDate } from '#services/activity_log'
import { authorizedOrganizationId, organizationFilter } from '#services/organization_scope'
import {
    paginationOf,
    requestedOrganizationId,
    storeTelegramBindingValidator,
} from '#validators/rules'

type TelegramBindingRow = {
    id: number
    organization_id: number
    telegram_chat_id: string
    bot_token_ref: string
    is_active: boolean
    created_at: Date | null
}

/**
 * bot_token_ref sengaja tidak diekspos penuh walau cuma referensi (standar
 * 6.1): 3 karakter awal & akhir terlihat, sisanya bintang.
 */
export function maskedTokenRef(ref: string): string {
    // Referensi berupa nama variabel/secret (ASCII), jadi panjang karakter
    // sama dengan strlen() PHP yang menghitung byte.
    if (ref.length <= 6) return '*'.repeat(ref.length)
    return ref.slice(0, 3) + '*'.repeat(ref.length - 6) + ref.slice(-3)
}

/** TelegramBindingResource. */
export function telegramBindingResource(binding: TelegramBindingRow) {
    return {
        id: binding.id,
        organization_id: binding.organization_id,
        telegram_chat_id: binding.telegram_chat_id,
        bot_token_ref_masked: maskedTokenRef(binding.bot_token_ref),
        is_active: binding.is_active,
        created_at: laravelDate(binding.created_at),
    }
}

/**
 * Pengikatan chat Telegram ke site -- padanan TelegramBindingController di
 * backend-api, kontrak sama.
 */
export default class TelegramBindingsController {
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'telegram.manage')) return forbidden(ctx)

        const filter = organizationFilter(access, requestedOrganizationId(ctx))
        if (filter === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melihat binding Telegram site ini'))
        }

        const { page, perPage } = paginationOf(ctx, 20)
        const query = db.from('telegram_bindings').orderBy('id', 'desc')
        if (filter !== 'all') {
            query.whereIn('organization_id', filter)
        }
        const bindings = await query.paginate(page, perPage)

        return success('Daftar binding Telegram', {
            items: bindings
                .all()
                .map((binding) => telegramBindingResource(binding as TelegramBindingRow)),
            total: bindings.total,
        })
    }

    async store(ctx: HttpContext) {
        // StoreTelegramBindingRequest::authorize() jalan sebelum validasi.
        const access = await accessOf(ctx)
        if (!can(access, 'telegram.manage')) return forbidden(ctx)

        const input = await ctx.request.validateUsing(storeTelegramBindingValidator)

        const organizationId = authorizedOrganizationId(access, input.organization_id)
        if (organizationId === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang menautkan Telegram untuk site ini'))
        }

        const now = new Date()
        const [binding] = await db
            .table('telegram_bindings')
            .insert({
                organization_id: organizationId,
                telegram_chat_id: input.telegram_chat_id,
                bot_token_ref: input.bot_token_ref,
                is_active: true,
                created_by: access.userId,
                updated_by: access.userId,
                created_at: now,
                updated_at: now,
            })
            .returning('*')

        return ctx.response
            .status(201)
            .send(success('Binding Telegram berhasil dibuat', telegramBindingResource(binding)))
    }

    /**
     * Dipakai bot Telegram (role telegram_bot_service) untuk mencocokkan
     * chat_id yang baru saja mengirim pesan ke organization_id-nya, tanpa
     * perlu permission 'telegram.manage' penuh (bot tidak boleh kelola
     * binding, hanya boleh tahu dia melayani site mana). Hanya organization_id
     * yang dibalas -- bot_token_ref dan field lain tidak diekspos di sini.
     */
    async lookup(ctx: HttpContext) {
        const chatId = stringInput(ctx.request.input('chat_id'))
        if (chatId === '') {
            return ctx.response.status(422).send(fail('chat_id wajib diisi'))
        }

        const binding = await db
            .from('telegram_bindings')
            .where('telegram_chat_id', chatId)
            .where('is_active', true)
            .orderBy('id')
            .first()

        if (!binding) {
            return ctx.response.status(404).send(fail('Chat ini belum terdaftar ke site mana pun'))
        }

        return success('Binding ditemukan', { organization_id: binding.organization_id })
    }

    async destroy(ctx: HttpContext) {
        // Route model binding (404) jalan sebelum cek izin di backend-api.
        const binding = await db
            .from('telegram_bindings')
            .where('id', String(ctx.params.telegram_binding))
            .first()
        if (!binding) return ctx.response.status(404).send(fail('Data tidak ditemukan'))

        const access = await accessOf(ctx)
        if (!can(access, 'telegram.manage')) return forbidden(ctx)

        if (authorizedOrganizationId(access, binding.organization_id) === null) {
            return ctx.response.status(403).send(fail('Anda tidak berwenang menghapus binding ini'))
        }

        await db.from('telegram_bindings').where('id', binding.id).delete()

        return success('Binding Telegram berhasil dihapus')
    }
}

/** $request->string('x')->toString(): nilai skalar sebagai teks, selain itu ''. */
export function stringInput(value: unknown): string {
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'bigint') return String(value)
    if (typeof value === 'boolean') return value ? '1' : ''
    return ''
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang melakukan tindakan ini'))
}
