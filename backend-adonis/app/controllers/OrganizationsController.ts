import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { accessOf, can } from '#services/Access'
import { fail, success } from '#services/ApiResponse'
import { logModelEvent } from '#services/ActivityLog'
import { escapeLike, searchTermOf } from '#services/SearchTerm'
import { normalizeSiteName, SITE_NAME_TAKEN_MESSAGE, siteNameTaken } from '#services/SiteName'
import {
    dirtyLogged,
    ORGANIZATION_LOGGED_FIELDS,
    ORGANIZATION_MORPH,
    organizationResource,
    pickLogged,
    routeId,
    type OrganizationRow,
} from '#services/UserResource'
import {
    generatedSiteCode,
    storeOrganizationValidator,
    UPDATE_ORGANIZATION_SOMETIMES,
    updateOrganizationValidator,
} from '#validators/Organizations'
import {
    lastPageOf,
    laravelInput,
    laravelMessages,
    pageOf,
    perPageOf,
    phpBooleanFlag,
} from '#validators/Users'

const ORGANIZATION_COLUMNS = [
    'organizations.id',
    'organizations.name',
    'organizations.type',
    'organizations.unique_site_code',
    'organizations.is_active',
    'organizations.created_at',
    'organizations.updated_at',
]

/**
 * Site/organization -- padanan OrganizationController (apiResource) di
 * backend-api. Semua aksi butuh permission organizations.manage. Site yang
 * di-soft-delete dianggap tidak ada.
 */
export default class OrganizationsController {
    async index(ctx: HttpContext) {
        if (!(await canManage(ctx))) return forbidden(ctx)

        const input = laravelInput(ctx)
        // Batas atas per_page: dropdown butuh banyak site, tapi bukan seluruh tabel tanpa batas.
        const perPage = Math.min(perPageOf(input, 15), MAX_PER_PAGE)
        const page = pageOf(input)
        const onlyActive = phpBooleanFlag(input.only_active)
        const search = searchTermOf(input.search)
        const status =
            input.status === 'active' || input.status === 'inactive' ? input.status : null

        const filtered = () => {
            const query = organizationsQuery()
            if (onlyActive) query.where('organizations.is_active', true)
            if (search) {
                const pattern = `%${escapeLike(search)}%`
                query.where((match) =>
                    match
                        .whereILike('organizations.name', pattern)
                        .orWhereILike('organizations.unique_site_code', pattern)
                )
            }
            return query
        }

        // Hitungan aktif/nonaktif & jumlah device mengikuti pencarian tetapi TIDAK filter status.
        const [countRows, rows, devicesRow] = await Promise.all([
            filtered()
                .select('organizations.is_active')
                .count('* as total')
                .groupBy('organizations.is_active'),
            filtered()
                .if(status === 'active', (query) => query.where('organizations.is_active', true))
                .if(status === 'inactive', (query) => query.where('organizations.is_active', false))
                .select(ORGANIZATION_COLUMNS)
                .select(devicesCount())
                .orderBy('organizations.name')
                .orderBy('organizations.id')
                .offset((page - 1) * perPage)
                .limit(perPage),
            db
                .from('devices')
                .whereNull('devices.deleted_at')
                .whereIn('devices.organization_id', filtered().select('organizations.id'))
                .count('* as total')
                .first(),
        ])

        const countOf = (active: boolean) =>
            Number(countRows.find((row) => Boolean(row.is_active) === active)?.total ?? 0)
        const activeCount = countOf(true)
        const inactiveCount = countOf(false)
        const total =
            status === 'active'
                ? activeCount
                : status === 'inactive'
                  ? inactiveCount
                  : activeCount + inactiveCount

        return success('Daftar site/organization', {
            items: (rows as OrganizationRow[]).map((row) => organizationResource(row)),
            total,
            last_page: lastPageOf(total, perPage),
            page,
            per_page: perPage,
            active_count: activeCount,
            inactive_count: inactiveCount,
            devices_total: Number(devicesRow?.total ?? 0),
        })
    }

    async store(ctx: HttpContext) {
        if (!(await canManage(ctx))) return forbidden(ctx)

        const data = await storeOrganizationValidator.validate(laravelInput(ctx), {
            messagesProvider: laravelMessages,
        })
        const name = normalizeSiteName(data.name)
        if (!name || (await siteNameTaken(name))) return nameInvalid(ctx, name)
        const actorId = ctx.authUser!.id
        const now = new Date()

        let row
        try {
            ;[row] = await db
                .table('organizations')
                .insert({
                    name,
                    type: data.type,
                    unique_site_code: generatedSiteCode(name),
                    is_active: true,
                    created_by: actorId,
                    updated_by: actorId,
                    created_at: now,
                    updated_at: now,
                })
                .returning(
                    ORGANIZATION_COLUMNS.map((column) => column.replace('organizations.', ''))
                )
        } catch (error) {
            // Dua permintaan nama sama bersamaan: indeks unik database yang menolak yang kedua.
            if (isUniqueViolation(error)) return nameInvalid(ctx, name)
            throw error
        }

        await logModelEvent(ctx, {
            event: 'created',
            subjectType: ORGANIZATION_MORPH,
            subjectId: row.id,
            organizationId: row.id,
            attributes: pickLogged(ORGANIZATION_LOGGED_FIELDS, row),
        })

        return ctx.response
            .status(201)
            .send(success('Site berhasil dibuat', organizationResource(row)))
    }

    async show(ctx: HttpContext) {
        const id = routeId(ctx.params.organization)
        const organization =
            id === null
                ? null
                : await organizationsQuery()
                      .where('organizations.id', id)
                      .select(ORGANIZATION_COLUMNS)
                      .select(devicesCount())
                      .first()
        if (!organization) return notFound(ctx)
        if (!(await canManage(ctx))) return forbidden(ctx)

        return success('Detail site', organizationResource(organization))
    }

    async update(ctx: HttpContext) {
        const organization = await findOrganization(ctx)
        if (!organization) return notFound(ctx)
        if (!(await canManage(ctx))) return forbidden(ctx)

        const data = await updateOrganizationValidator.validate(
            laravelInput(ctx, { sometimes: UPDATE_ORGANIZATION_SOMETIMES }),
            { messagesProvider: laravelMessages }
        )

        const changes: Record<string, unknown> = { updated_by: ctx.authUser!.id }
        if (data.name !== undefined) {
            const name = normalizeSiteName(data.name)
            if (!name || (await siteNameTaken(name, organization.id))) return nameInvalid(ctx, name)
            changes.name = name
        }
        if (data.is_active !== undefined) changes.is_active = data.is_active

        // Eloquent hanya menyimpan kalau ada yang berubah (updated_by ikut
        // dihitung), dan hanya field tercatat yang masuk log.
        const before = organization as unknown as Record<string, unknown>
        const dirty = Object.fromEntries(
            Object.entries(changes).filter(([key, value]) => before[key] !== value)
        )

        let current = organization
        if (Object.keys(dirty).length > 0) {
            let updated
            try {
                ;[updated] = await db
                    .from('organizations')
                    .where('id', organization.id)
                    .update({ ...dirty, updated_at: new Date() })
                    .returning(
                        ORGANIZATION_COLUMNS.map((column) => column.replace('organizations.', ''))
                    )
            } catch (error) {
                if (isUniqueViolation(error)) return nameInvalid(ctx, String(dirty.name ?? ''))
                throw error
            }
            current = updated

            const logged = dirtyLogged(ORGANIZATION_LOGGED_FIELDS, before, dirty)
            if (logged) {
                await logModelEvent(ctx, {
                    event: 'updated',
                    subjectType: ORGANIZATION_MORPH,
                    subjectId: organization.id,
                    organizationId: organization.id,
                    attributes: logged.attributes,
                    old: logged.old,
                })
            }
        }

        return success('Site berhasil diperbarui', organizationResource(current))
    }

    async destroy(ctx: HttpContext) {
        const organization = await findOrganization(ctx)
        if (!organization) return notFound(ctx)
        if (!(await canManage(ctx))) return forbidden(ctx)

        // Soft delete: deleted_at & updated_at diisi.
        const now = new Date()
        await db
            .from('organizations')
            .where('id', organization.id)
            .update({ deleted_at: now, updated_at: now })

        await logModelEvent(ctx, {
            event: 'deleted',
            subjectType: ORGANIZATION_MORPH,
            subjectId: organization.id,
            organizationId: organization.id,
            attributes: pickLogged(
                ORGANIZATION_LOGGED_FIELDS,
                organization as unknown as Record<string, unknown>
            ),
        })

        return success('Site berhasil dihapus (soft delete)')
    }
}

/** Per halaman paling banyak yang dilayani daftar site. */
const MAX_PER_PAGE = 200

function organizationsQuery() {
    return db.from('organizations').whereNull('organizations.deleted_at')
}

/** withCount('devices'): device yang di-soft-delete tidak ikut dihitung. */
function devicesCount() {
    return db
        .from('devices')
        .whereColumn('devices.organization_id', 'organizations.id')
        .whereNull('devices.deleted_at')
        .count('*')
        .as('devices_count')
}

/** Route model binding Organization (404 kalau tidak ada / sudah dihapus). */
async function findOrganization(ctx: HttpContext): Promise<OrganizationRow | null> {
    const id = routeId(ctx.params.organization)
    if (id === null) return null
    return (
        (await organizationsQuery()
            .where('organizations.id', id)
            .select([...ORGANIZATION_COLUMNS, 'organizations.updated_by'])
            .first()) ?? null
    )
}

async function canManage(ctx: HttpContext) {
    return can(await accessOf(ctx), 'organizations.manage')
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang melakukan tindakan ini'))
}

function notFound(ctx: HttpContext) {
    return ctx.response.status(404).send(fail('Data tidak ditemukan'))
}

/** 422 gaya validasi: nama kosong (hanya spasi) atau sudah dipakai site lain. */
function nameInvalid(ctx: HttpContext, name: string) {
    return ctx.response.status(422).send(
        fail('Data yang diberikan tidak valid.', {
            name: [name ? SITE_NAME_TAKEN_MESSAGE : 'Nama site wajib diisi.'],
        })
    )
}

const isUniqueViolation = (error: unknown) => (error as { code?: string })?.code === '23505'
