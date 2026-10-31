import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { accessOf, can, type Access } from '#services/Access'
import {
    laravelDate,
    logModelEvent,
    WORK_SESSION_MORPH,
    writeActivity,
} from '#services/ActivityLog'
import {
    applyBulkSiteAccess,
    parseBulkSiteAccess,
    partitionUsers,
    resolveOrganizations,
    scopesOfUsers,
    summarize,
    type SkippedUser,
} from '#services/BulkSiteAccess'
import { removeBroadcaster } from '#services/Livekit'
import { hasGrantBasedAccess } from '#services/OrganizationScope'
import { ROLE_NAME_PATTERN } from '#services/RoleRules'
import { MAX_LOOKUP_EMAILS, parseBulkUserUpdate, parseEmailList } from '#services/BulkUserUpdate'
import { escapeLike, searchTermOf } from '#services/SearchTerm'
import { closeSession, openSessionOf } from '#services/WorkPresence'
import { fail, success } from '#services/ApiResponse'
import { hashLaravelPassword } from '#services/laravel/Bcrypt'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'
import {
    findUser,
    freshUserResource,
    logUserChanges,
    logUserSnapshot,
    routeId,
    USER_COLUMNS,
    userResource,
    userResources,
    usersQuery,
    type UserRow,
} from '#services/UserResource'
import {
    laravelInput,
    laravelMessages,
    pageOf,
    perPageOf,
    requestInteger,
    storeUserInput,
    storeUserValidator,
    syncSiteAccessValidator,
    UPDATE_USER_SOMETIMES,
    updateUserValidator,
} from '#validators/Users'

/**
 * Kelola staf yang bisa login ke web dashboard & APK master (permission
 * users.manage -- hari ini cuma dipegang super_admin). Padanan
 * UserController di backend-api, kontrak sama.
 *
 * Urutan cek sama dengan Laravel: staf di route dicari dulu (404), baru izin
 * (403), baru validasi (422).
 */
export default class UsersController {
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const manager = can(access, 'users.manage')
        // Admin & leader: hanya staf (peran staff_viewer) di site yang
        // dipegangnya -- cukup untuk menonaktifkan/mengaktifkan kembali.
        if (!manager && !hasGrantBasedAccess(access)) return forbidden(ctx)

        const input = laravelInput(ctx)
        // Batas atas per_page: satu permintaan tidak boleh menarik seluruh tabel.
        const perPage = Math.min(perPageOf(input, 20), MAX_PER_PAGE)
        const page = pageOf(input)
        const organizationId = requestInteger(input, 'organization_id')
        const search = searchTermOf(input.search)
        const role =
            typeof input.role === 'string' && ROLE_NAME_PATTERN.test(input.role) ? input.role : null
        const status =
            input.status === 'active' || input.status === 'suspended' ? input.status : null

        const filtered = () => {
            const query = usersQuery()
            if (organizationId) query.where('organization_id', organizationId)
            if (search) {
                const pattern = `%${escapeLike(search)}%`
                query.where((match) =>
                    match
                        .whereILike('name', pattern)
                        .orWhereILike('username', pattern)
                        .orWhereILike('email', pattern)
                )
            }
            if (role) query.whereIn('id', usersWithRoles([role]))
            if (!manager) {
                query
                    .whereIn('organization_id', access.grantedOrganizationIds)
                    .whereIn('id', usersWithRoles([STAFF_ROLE]))
                    .whereNotIn('id', usersWithRolesExcept(STAFF_ROLE))
            }
            return query
        }

        // Hitungan aktif/disuspen mengikuti pencarian & peran tetapi TIDAK filter status,
        // supaya angka ringkasan di header tetap menunjukkan sebarannya.
        const [countRows, rows] = await Promise.all([
            filtered().select('is_active').count('* as total').groupBy('is_active'),
            filtered()
                .if(status === 'active', (query) => query.where('is_active', true))
                .if(status === 'suspended', (query) => query.where('is_active', false))
                .orderBy('name')
                .orderBy('id')
                .select(USER_COLUMNS)
                .offset((page - 1) * perPage)
                .limit(perPage),
        ])

        const countOf = (active: boolean) =>
            Number(countRows.find((row) => Boolean(row.is_active) === active)?.total ?? 0)
        const activeCount = countOf(true)
        const suspendedCount = countOf(false)
        const total =
            status === 'active'
                ? activeCount
                : status === 'suspended'
                  ? suspendedCount
                  : activeCount + suspendedCount

        return success('Daftar staf', {
            items: await userResources(rows as UserRow[]),
            total,
            active_count: activeCount,
            suspended_count: suspendedCount,
            page,
            per_page: perPage,
            last_page: Math.max(Math.ceil(total / perPage), 1),
        })
    }

    async store(ctx: HttpContext) {
        if (!(await canManage(ctx))) return forbidden(ctx)

        const data = await storeUserValidator.validate(storeUserInput(ctx.request.all()), {
            messagesProvider: laravelMessages,
        })
        const actorId = ctx.authUser!.id
        const password = await hashLaravelPassword(data.password)

        const userId = await db.transaction(async (trx) => {
            const now = new Date()
            const [created] = await trx
                .table('users')
                .insert({
                    name: data.name,
                    username: data.username,
                    email: data.email,
                    password,
                    organization_id: data.organization_id ?? null,
                    // Login pertama tetap memicu enrollment 2FA lewat
                    // AuthController, sama seperti akun lain.
                    is_active: true,
                    created_at: now,
                    updated_at: now,
                })
                .returning('id')
            const id = Number(typeof created === 'object' ? created.id : created)

            await assignRole(trx, id, data.role)

            if (data.site_access && data.site_access.length > 0) {
                await syncSites(trx, id, data.site_access, actorId)
            }
            return id
        })

        await logUserSnapshot(ctx, 'created', userId)

        return ctx.response
            .status(201)
            .send(success('Staf berhasil dibuat', await freshUserResource(userId)))
    }

    async show(ctx: HttpContext) {
        const user = await findUser(routeId(ctx.params.user))
        if (!user) return notFound(ctx)
        if (!(await canManage(ctx))) return forbidden(ctx)

        return success('Detail staf', await userResource(user))
    }

    async update(ctx: HttpContext) {
        const user = await findUser(routeId(ctx.params.user))
        if (!user) return notFound(ctx)
        if (!(await canManage(ctx))) return forbidden(ctx)

        const data = await updateUserValidator.validate(
            laravelInput(ctx, { sometimes: UPDATE_USER_SOMETIMES }),
            { messagesProvider: laravelMessages, meta: { userId: user.id } }
        )

        // array_filter(): nilai null dibuang, jadi organization_id tidak bisa
        // dikosongkan lewat endpoint ini (sama seperti backend-api).
        const changes: Record<string, unknown> = {}
        if (data.name !== undefined) changes.name = data.name
        if (data.email !== undefined) changes.email = data.email
        if (data.organization_id !== undefined && data.organization_id !== null) {
            changes.organization_id = data.organization_id
        }
        if (data.password !== undefined) {
            changes.password = await hashLaravelPassword(data.password)
        }

        // Eloquent hanya menyimpan (dan menggeser updated_at) kalau ada yang
        // berubah; password baru selalu dianggap berubah (hash baru).
        const dirty = Object.entries(changes).filter(
            ([key, value]) => key === 'password' || (user as Record<string, unknown>)[key] !== value
        )

        await db.transaction(async (trx) => {
            if (dirty.length > 0) {
                await trx
                    .from('users')
                    .where('id', user.id)
                    .update({ ...Object.fromEntries(dirty), updated_at: new Date() })
            }
            if (data.role !== undefined) {
                // syncRoles(): lepas semua peran lalu pasang yang baru.
                await trx
                    .from('model_has_roles')
                    .where('model_type', LARAVEL_USER_MORPH)
                    .where('model_id', user.id)
                    .delete()
                await assignRole(trx, user.id, data.role)
            }
        })

        await logUserChanges(
            ctx,
            user,
            Object.fromEntries(dirty),
            (changes.organization_id as number | undefined) ?? user.organization_id
        )

        return success('Staf berhasil diperbarui', await freshUserResource(user.id))
    }

    async destroy(ctx: HttpContext) {
        const user = await findUser(routeId(ctx.params.user))
        if (!user) return notFound(ctx)
        if (!(await canManage(ctx))) return forbidden(ctx)

        if (user.id === ctx.authUser!.id) {
            return ctx.response.status(422).send(fail('Tidak bisa menghapus akun sendiri'))
        }

        // Soft delete (SoftDeletes): deleted_at & updated_at diisi.
        const now = new Date()
        await db.from('users').where('id', user.id).update({ deleted_at: now, updated_at: now })
        await logUserSnapshot(ctx, 'deleted', user.id)
        // Staf yang dihapus juga langsung keluar dari Live Kerja & socket-nya
        // (gateway memutus socket begitu tokennya hilang).
        await db.transaction((trx) => deleteTokens(trx, user.id))
        await endLiveWork(ctx, user.id, 'deleted')

        return success('Staf berhasil dihapus')
    }

    async suspend(ctx: HttpContext) {
        const user = await findUser(routeId(ctx.params.user))
        if (!user) return notFound(ctx)
        if (!(await canChangeStatus(await accessOf(ctx), user))) return forbidden(ctx)

        if (user.id === ctx.authUser!.id) {
            return ctx.response.status(422).send(fail('Tidak bisa men-suspend akun sendiri'))
        }

        await db.transaction(async (trx) => {
            if (user.is_active !== false) {
                await trx
                    .from('users')
                    .where('id', user.id)
                    .update({ is_active: false, updated_at: new Date() })
            }
            // Semua sesi login dicabut supaya staf langsung keluar.
            await deleteTokens(trx, user.id)
        })
        await logUserChanges(ctx, user, { is_active: false }, user.organization_id)
        // Langsung putus juga dari Live Kerja: sesi kerja ditutup & dikeluarkan
        // dari room LiveKit. Socket dashboard/APK-nya diputus gateway begitu
        // tokennya hilang (realtime-gateway, cek token berkala).
        await endLiveWork(ctx, user.id, 'suspended')

        return success('Staf disuspen — semua sesi login dicabut', await freshUserResource(user.id))
    }

    async reactivate(ctx: HttpContext) {
        const user = await findUser(routeId(ctx.params.user))
        if (!user) return notFound(ctx)
        if (!(await canChangeStatus(await accessOf(ctx), user))) return forbidden(ctx)

        if (user.is_active !== true) {
            await db
                .from('users')
                .where('id', user.id)
                .update({ is_active: true, updated_at: new Date() })
            await logUserChanges(ctx, user, { is_active: true }, user.organization_id)
        }

        return success('Staf diaktifkan kembali', await freshUserResource(user.id))
    }

    /**
     * Reset 2FA staf (HP authenticator-nya hilang/ganti) -- secret & recovery
     * codes dikosongkan supaya login berikutnya memicu setup 2FA dari awal
     * (QR code baru). Sesi login yang aktif ikut dicabut supaya device lama
     * tidak bisa dipakai lagi tanpa setup ulang -- konsisten dengan suspend().
     */
    async reset2fa(ctx: HttpContext) {
        const user = await findUser(routeId(ctx.params.user))
        if (!user) return notFound(ctx)
        if (!(await canManage(ctx))) return forbidden(ctx)

        await db.transaction(async (trx) => {
            const current = await trx
                .from('users')
                .where('id', user.id)
                .select('two_factor_secret', 'two_factor_recovery_codes', 'two_factor_confirmed_at')
                .first()
            const dirty =
                current &&
                (current.two_factor_secret !== null ||
                    current.two_factor_recovery_codes !== null ||
                    current.two_factor_confirmed_at !== null)
            if (dirty) {
                await trx.from('users').where('id', user.id).update({
                    two_factor_secret: null,
                    two_factor_recovery_codes: null,
                    two_factor_confirmed_at: null,
                    updated_at: new Date(),
                })
            }
            await deleteTokens(trx, user.id)
        })
        // Kolom 2FA tidak termasuk logOnly User, jadi tidak ada log model.

        return success(
            `2FA ${user.name} direset — login berikutnya akan diminta setup ulang`,
            await freshUserResource(user.id)
        )
    }

    /** Atur site mana saja yang boleh dilihat user dengan role admin/leader. */
    async syncSiteAccess(ctx: HttpContext) {
        const user = await findUser(routeId(ctx.params.user))
        if (!user) return notFound(ctx)
        if (!(await canManage(ctx))) return forbidden(ctx)

        const data = await syncSiteAccessValidator.validate(
            laravelInput(ctx, { requiredArrays: ['organization_ids'] }),
            { messagesProvider: laravelMessages }
        )

        await db.transaction((trx) =>
            syncSites(trx, user.id, data.organization_ids, ctx.authUser!.id)
        )

        await writeActivity(ctx, {
            logName: 'default',
            description: 'Akses site diperbarui',
            event: 'updated',
            subjectType: LARAVEL_USER_MORPH,
            subjectId: user.id,
            organizationId: null,
            properties: { site_count: new Set(data.organization_ids).size },
        })

        return success('Akses site diperbarui', await freshUserResource(user.id))
    }

    /**
     * Cocokkan banyak email sekaligus (tempel daftar di dialog Update staf): mana yang ada sebagai
     * staf (belum dihapus) dan mana yang tidak. Huruf besar/kecil tidak dibedakan.
     */
    async lookup(ctx: HttpContext) {
        if (!(await canManage(ctx))) return forbidden(ctx)

        const parsed = parseEmailList(ctx.request.input('emails'))
        if (!parsed) {
            return ctx.response.status(422).send(
                fail('Data yang diberikan tidak valid.', {
                    emails: ['Daftar email harus berupa array teks.'],
                })
            )
        }
        if (parsed.emails.length + parsed.invalid.length > MAX_LOOKUP_EMAILS) {
            return ctx.response.status(422).send(
                fail('Data yang diberikan tidak valid.', {
                    emails: [`Paling banyak ${MAX_LOOKUP_EMAILS} email sekali tempel.`],
                })
            )
        }

        const rows =
            parsed.emails.length > 0
                ? await db
                      .from('users')
                      .whereNull('deleted_at')
                      .whereRaw(
                          `lower(email) in (${parsed.emails.map(() => '?').join(',')})`,
                          parsed.emails
                      )
                      .select('id', 'name', 'email')
                : []
        const foundEmails = new Set(rows.map((row) => String(row.email).toLowerCase()))

        return success('Hasil pencocokan email', {
            found: rows.map((row) => ({ id: Number(row.id), name: row.name, email: row.email })),
            missing: parsed.emails.filter((email) => !foundEmails.has(email)),
            invalid: parsed.invalid,
        })
    }

    /**
     * Update massal (menu Staf > Update): ganti peran, aktifkan / suspen, dan/atau atur akses
     * site banyak staf sekaligus. Hanya pemegang users.manage (super_admin). Satu transaksi;
     * staf yang tidak boleh diubah (akun layanan, akun sendiri untuk peran & status, peran
     * tanpa akses per site untuk bagian site) dilewati dan dilaporkan.
     */
    async bulkUpdate(ctx: HttpContext) {
        if (!(await canManage(ctx))) return forbidden(ctx)

        const parsed = parseBulkUserUpdate(ctx.request.all())
        if (!parsed.ok) {
            return ctx.response
                .status(422)
                .send(fail('Data yang diberikan tidak valid.', parsed.errors))
        }
        const input = parsed.data
        const actorId = ctx.authUser!.id

        let roleId: number | null = null
        if (input.role) {
            const role = await db
                .from('roles')
                .where({ name: input.role, guard_name: 'web' })
                .whereNot('name', 'telegram_bot_service')
                .select('id')
                .first()
            if (!role) {
                return ctx.response.status(422).send(
                    fail('Data yang diberikan tidak valid.', {
                        role: ['Peran tidak ditemukan.'],
                    })
                )
            }
            roleId = Number(role.id)
        }

        const outcome = await db.transaction(async (trx) => {
            // Site dicek lebih dulu: ada yang tidak valid = tidak ada satu pun perubahan ditulis.
            let siteIds: number[] = []
            if (input.sites) {
                const resolved = await resolveOrganizations(trx, input.sites.organizationIds)
                if (resolved.missing.length > 0) {
                    return { kind: 'missing', missing: resolved.missing } as const
                }
                if (input.sites.mode !== 'remove' && resolved.ids.length === 0) {
                    return { kind: 'noSites' } as const
                }
                siteIds = resolved.ids
            }

            const rows = await trx
                .from('users')
                .whereIn('id', input.userIds)
                .whereNull('deleted_at')
                .select('id', 'name', 'is_active')
            const found = new Map(rows.map((row) => [Number(row.id), row]))
            const serviceRows = await trx
                .from('model_has_roles')
                .join('roles', 'roles.id', 'model_has_roles.role_id')
                .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
                .whereIn('model_has_roles.model_id', input.userIds)
                .where('roles.name', 'telegram_bot_service')
                .select('model_has_roles.model_id')
            const serviceIds = new Set(serviceRows.map((row) => Number(row.model_id)))

            const skipped: SkippedUser[] = []
            const eligible: number[] = []
            for (const id of input.userIds) {
                const row = found.get(id)
                if (!row) skipped.push({ id, name: null, reason: 'Staf tidak ditemukan' })
                else if (serviceIds.has(id)) {
                    skipped.push({ id, name: row.name, reason: 'Akun layanan tidak bisa diubah' })
                } else eligible.push(id)
            }

            // Peran & status akun sendiri tidak diubah di sini (supaya tidak mengunci diri sendiri).
            let accountIds = eligible
            if ((roleId !== null || input.status) && eligible.includes(actorId)) {
                accountIds = eligible.filter((id) => id !== actorId)
                skipped.push({
                    id: actorId,
                    name: found.get(actorId)?.name ?? null,
                    reason: 'Peran & status akun sendiri tidak bisa diubah di sini',
                })
            }

            // Peran dipindahkan: semua peran lama dilepas, diganti satu peran pilihan. Staf yang
            // peran satu-satunya sudah peran itu dibiarkan (tidak disentuh, tidak dihitung berubah).
            let roleMoved: number[] = []
            if (roleId !== null && accountIds.length > 0) {
                const current = await trx
                    .from('model_has_roles')
                    .where('model_type', LARAVEL_USER_MORPH)
                    .whereIn('model_id', accountIds)
                    .select('model_id', 'role_id')
                const rolesOf = new Map<number, number[]>()
                for (const row of current) {
                    const list = rolesOf.get(Number(row.model_id)) ?? []
                    list.push(Number(row.role_id))
                    rolesOf.set(Number(row.model_id), list)
                }
                roleMoved = accountIds.filter((id) => {
                    const list = rolesOf.get(id) ?? []
                    return !(list.length === 1 && list[0] === roleId)
                })
                if (roleMoved.length > 0) {
                    await trx
                        .from('model_has_roles')
                        .where('model_type', LARAVEL_USER_MORPH)
                        .whereIn('model_id', roleMoved)
                        .delete()
                    await trx.table('model_has_roles').multiInsert(
                        roleMoved.map((id) => ({
                            role_id: roleId,
                            model_type: LARAVEL_USER_MORPH,
                            model_id: id,
                        }))
                    )
                }
            }

            let siteUserIds: number[] = []
            if (input.sites) {
                // Cara mengatur site mengikuti cakupan peran SETELAH perubahan peran di atas.
                const scopes = await scopesOfUsers(trx, eligible)
                const skipSite = (id: number, reason: string) => {
                    if (skipped.some((item) => item.id === id)) return
                    skipped.push({ id, name: found.get(id)?.name ?? null, reason })
                }
                const grantedIds = eligible.filter((id) => scopes.get(id) === 'granted')
                const ownIds = eligible.filter((id) => scopes.get(id) === 'own')
                for (const id of eligible.filter((item) => scopes.get(item) === 'all')) {
                    skipSite(id, 'Peran ini sudah melihat semua site')
                }

                await applyBulkSiteAccess(trx, {
                    userIds: grantedIds,
                    organizationIds: siteIds,
                    mode: input.sites.mode,
                    grantedBy: actorId,
                    removeEverything:
                        input.sites.mode === 'remove' && input.sites.organizationIds === 'all',
                })
                siteUserIds = [...grantedIds]

                // Peran terikat satu site (mis. Staff Viewer): staf ditempatkan di site yang dipilih.
                if (ownIds.length > 0) {
                    if (input.sites.mode === 'remove') {
                        for (const id of ownIds) {
                            skipSite(
                                id,
                                'Staf terikat satu site: ganti ke site lain, bukan dicabut'
                            )
                        }
                    } else if (input.sites.organizationIds === 'all' || siteIds.length !== 1) {
                        for (const id of ownIds) {
                            skipSite(id, 'Peran ini terikat satu site: pilih tepat satu site')
                        }
                    } else {
                        await trx
                            .from('users')
                            .whereIn('id', ownIds)
                            .update({ organization_id: siteIds[0], updated_at: new Date() })
                        siteUserIds = [...siteUserIds, ...ownIds]
                    }
                }
            }

            const activated: number[] = []
            const suspended: number[] = []
            if (input.status === 'active') {
                for (const id of accountIds)
                    if (found.get(id)?.is_active !== true) activated.push(id)
                if (activated.length > 0) {
                    await trx
                        .from('users')
                        .whereIn('id', activated)
                        .update({ is_active: true, updated_at: new Date() })
                }
            } else if (input.status === 'suspended') {
                for (const id of accountIds)
                    if (found.get(id)?.is_active !== false) suspended.push(id)
                if (suspended.length > 0) {
                    await trx
                        .from('users')
                        .whereIn('id', suspended)
                        .update({ is_active: false, updated_at: new Date() })
                }
                // Semua sesi login yang disuspen dicabut supaya langsung keluar.
                if (accountIds.length > 0) {
                    await trx
                        .from('personal_access_tokens')
                        .where('tokenable_type', LARAVEL_USER_MORPH)
                        .whereIn('tokenable_id', accountIds)
                        .delete()
                }
            }

            return {
                kind: 'done',
                skipped,
                roleChanged: roleMoved.length,
                roleUnchanged: roleId !== null ? accountIds.length - roleMoved.length : 0,
                activated,
                suspended,
                siteChanged: siteUserIds.length,
                touched: new Set([...accountIds, ...siteUserIds]).size,
            } as const
        })

        if (outcome.kind === 'missing') {
            return ctx.response.status(422).send(
                fail('Data yang diberikan tidak valid.', {
                    organization_ids: [`Site tidak ditemukan: ${outcome.missing.join(', ')}`],
                })
            )
        }
        if (outcome.kind === 'noSites') {
            return ctx.response.status(422).send(
                fail('Data yang diberikan tidak valid.', {
                    organization_ids: ['Belum ada site yang bisa diberikan.'],
                })
            )
        }

        // Yang baru disuspen langsung keluar dari Live Kerja; kegagalan satu staf tidak menghentikan yang lain.
        let liveErrors = 0
        for (const id of outcome.suspended) {
            try {
                await endLiveWork(ctx, id, 'suspended')
            } catch {
                liveErrors += 1
            }
        }

        if (outcome.touched > 0) {
            await writeActivity(ctx, {
                logName: 'default',
                description: 'Staf diperbarui massal',
                event: 'updated',
                subjectType: LARAVEL_USER_MORPH,
                subjectId: null,
                organizationId: null,
                properties: {
                    user_ids: input.userIds.slice(0, 200),
                    role: input.role,
                    status: input.status,
                    site_mode: input.sites?.mode ?? null,
                    all_sites: input.sites?.organizationIds === 'all',
                    role_changed: outcome.roleChanged,
                    role_unchanged: outcome.roleUnchanged,
                    activated: outcome.activated.length,
                    suspended: outcome.suspended.length,
                    site_changed: outcome.siteChanged,
                },
            })
        }

        return success(
            outcome.touched > 0
                ? `${outcome.touched} staf diperbarui`
                : 'Tidak ada staf yang bisa diperbarui',
            {
                requested: input.userIds.length,
                role_changed: outcome.roleChanged,
                role_unchanged: outcome.roleUnchanged,
                activated: outcome.activated.length,
                suspended: outcome.suspended.length,
                site_changed: outcome.siteChanged,
                live_errors: liveErrors,
                skipped: outcome.skipped,
            }
        )
    }

    /**
     * Atur akses site banyak user sekaligus (tambah / cabut / ganti), termasuk
     * "semua site". Hanya pemegang users.manage (super_admin). Satu transaksi.
     */
    async bulkSiteAccess(ctx: HttpContext) {
        if (!(await canManage(ctx))) return forbidden(ctx)

        const parsed = parseBulkSiteAccess(ctx.request.all())
        if (!parsed.ok) {
            return ctx.response
                .status(422)
                .send(fail('Data yang diberikan tidak valid.', parsed.errors))
        }
        const input = parsed.data

        const outcome = await db.transaction(async (trx) => {
            const { eligible, skipped } = await partitionUsers(trx, input.userIds)
            const { ids, missing } = await resolveOrganizations(trx, input.organizationIds)
            if (missing.length > 0) return { kind: 'missing', missing } as const
            if (input.mode !== 'remove' && ids.length === 0) return { kind: 'noSites' } as const

            await applyBulkSiteAccess(trx, {
                userIds: eligible,
                organizationIds: ids,
                mode: input.mode,
                grantedBy: ctx.authUser!.id,
                removeEverything: input.mode === 'remove' && input.organizationIds === 'all',
            })
            return { kind: 'done', eligible, skipped, siteCount: ids.length } as const
        })

        if (outcome.kind === 'missing') {
            return ctx.response.status(422).send(
                fail('Data yang diberikan tidak valid.', {
                    organization_ids: [`Site tidak ditemukan: ${outcome.missing.join(', ')}`],
                })
            )
        }
        if (outcome.kind === 'noSites') {
            return ctx.response.status(422).send(
                fail('Data yang diberikan tidak valid.', {
                    organization_ids: ['Belum ada site yang bisa diberikan.'],
                })
            )
        }

        if (outcome.eligible.length > 0) {
            await writeActivity(ctx, {
                logName: 'default',
                description: 'Akses site diatur massal',
                event: 'updated',
                subjectType: LARAVEL_USER_MORPH,
                subjectId: null,
                organizationId: null,
                properties: summarize(input, outcome.siteCount, outcome.eligible.length),
            })
        }

        return success(
            outcome.eligible.length > 0
                ? `Akses site ${outcome.eligible.length} user diperbarui`
                : 'Tidak ada user yang bisa diatur',
            {
                updated_users: outcome.eligible.length,
                site_count: outcome.siteCount,
                mode: input.mode,
                skipped: outcome.skipped,
            }
        )
    }
}

async function canManage(ctx: HttpContext) {
    return can(await accessOf(ctx), 'users.manage')
}

const STAFF_ROLE = 'staff_viewer'

/** Per halaman paling banyak yang dilayani daftar staf. */
const MAX_PER_PAGE = 100

/** id user yang punya salah satu peran ini (subquery). */
function usersWithRoles(roles: string[]) {
    return db
        .from('model_has_roles')
        .join('roles', 'roles.id', 'model_has_roles.role_id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .whereIn('roles.name', roles)
        .select('model_has_roles.model_id')
}

/** id user yang punya peran SELAIN peran ini (subquery). */
function usersWithRolesExcept(role: string) {
    return db
        .from('model_has_roles')
        .join('roles', 'roles.id', 'model_has_roles.role_id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .whereNot('roles.name', role)
        .select('model_has_roles.model_id')
}

/**
 * Menonaktifkan / mengaktifkan kembali: super_admin (users.manage) siapa pun;
 * admin & leader hanya staf biasa (peran staff_viewer saja) di site yang
 * diberikan kepadanya -- tidak bisa menyentuh admin, leader, atau root.
 */
async function canChangeStatus(access: Access, user: UserRow): Promise<boolean> {
    if (can(access, 'users.manage')) return true
    if (!hasGrantBasedAccess(access)) return false
    if (
        user.organization_id === null ||
        !access.grantedOrganizationIds.includes(user.organization_id)
    ) {
        return false
    }
    const roles = await db
        .from('model_has_roles')
        .join('roles', 'roles.id', 'model_has_roles.role_id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .where('model_has_roles.model_id', user.id)
        .select('roles.name')
    return roles.length > 0 && roles.every((role) => role.name === STAFF_ROLE)
}

/** Tutup sesi Live Kerja yang masih terbuka & keluarkan dari room LiveKit. */
async function endLiveWork(ctx: HttpContext, userId: number, reason: string) {
    const session = await openSessionOf(userId)
    if (!session) return
    await closeSession(session, reason, 'work_end')
    await logModelEvent(ctx, {
        event: 'updated',
        subjectType: WORK_SESSION_MORPH,
        subjectId: session.id,
        organizationId: session.organization_id,
        attributes: { ended_at: laravelDate(session.ended_at), end_reason: reason },
        old: { ended_at: null, end_reason: null },
    })
    await removeBroadcaster(session.organization_id, userId)
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang melakukan tindakan ini'))
}

function notFound(ctx: HttpContext) {
    return ctx.response.status(404).send(fail('Data tidak ditemukan'))
}

/** assignRole() spatie: peran guard 'web'; nama yang tidak ada = error server. */
async function assignRole(trx: TransactionClientContract, userId: number, roleName: string) {
    const role = await trx
        .from('roles')
        .where('name', roleName)
        .where('guard_name', 'web')
        .select('id')
        .first()
    if (!role) {
        throw new Error(`Role "${roleName}" tidak ada untuk guard web`)
    }
    await trx
        .table('model_has_roles')
        .insert({ role_id: role.id, model_type: LARAVEL_USER_MORPH, model_id: userId })
        .onConflict(['role_id', 'model_id', 'model_type'])
        .ignore()
}

/** $user->tokens()->delete(): cabut semua token Sanctum staf ini. */
async function deleteTokens(trx: TransactionClientContract, userId: number) {
    await trx
        .from('personal_access_tokens')
        .where('tokenable_type', LARAVEL_USER_MORPH)
        .where('tokenable_id', userId)
        .delete()
}

/**
 * siteAccess()->sync([...] dengan granted_by): site yang tidak disebut
 * dilepas, site baru ditambahkan, site yang sudah ada diperbarui granted_by
 * & updated_at-nya (updateExistingPivot).
 */
async function syncSites(
    trx: TransactionClientContract,
    userId: number,
    organizationIds: number[],
    grantedBy: number
) {
    const wanted = [...new Set(organizationIds)]
    const now = new Date()

    const removed = trx.from('user_site_access').where('user_id', userId)
    if (wanted.length > 0) removed.whereNotIn('organization_id', wanted)
    await removed.delete()

    if (wanted.length === 0) return

    const existing = await trx
        .from('user_site_access')
        .where('user_id', userId)
        .whereIn('organization_id', wanted)
        .select('organization_id')
    const existingIds = new Set(existing.map((row) => Number(row.organization_id)))

    if (existingIds.size > 0) {
        await trx
            .from('user_site_access')
            .where('user_id', userId)
            .whereIn('organization_id', [...existingIds])
            .update({ granted_by: grantedBy, updated_at: now })
    }

    const added = wanted.filter((id) => !existingIds.has(id))
    if (added.length > 0) {
        await trx.table('user_site_access').multiInsert(
            added.map((organizationId) => ({
                user_id: userId,
                organization_id: organizationId,
                granted_by: grantedBy,
                created_at: now,
                updated_at: now,
            }))
        )
    }
}
