import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { accessOf, can } from '#services/access'
import { fail, success } from '#services/api_response'
import { logModelEvent } from '#services/activity_log'
import {
    dirtyLogged,
    ORGANIZATION_LOGGED_FIELDS,
    ORGANIZATION_MORPH,
    organizationResource,
    pickLogged,
    routeId,
    type OrganizationRow,
} from '#services/user_resource'
import {
    generatedSiteCode,
    storeOrganizationValidator,
    UPDATE_ORGANIZATION_SOMETIMES,
    updateOrganizationValidator,
} from '#validators/organizations'
import {
    lastPageOf,
    laravelInput,
    laravelMessages,
    pageOf,
    perPageOf,
    phpBooleanFlag,
} from '#validators/users'

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
        const perPage = perPageOf(input, 15)
        const page = pageOf(input)
        const onlyActive = phpBooleanFlag(input.only_active)

        const filtered = () => {
            const query = organizationsQuery()
            if (onlyActive) query.where('organizations.is_active', true)
            return query
        }

        const [countRow, rows] = await Promise.all([
            filtered().count('* as total').first(),
            filtered()
                .select(ORGANIZATION_COLUMNS)
                .select(devicesCount())
                .orderBy('organizations.name')
                .offset((page - 1) * perPage)
                .limit(perPage),
        ])
        const total = Number(countRow?.total ?? 0)

        return success('Daftar site/organization', {
            items: (rows as OrganizationRow[]).map((row) => organizationResource(row)),
            total,
            last_page: lastPageOf(total, perPage),
        })
    }

    async store(ctx: HttpContext) {
        if (!(await canManage(ctx))) return forbidden(ctx)

        const data = await storeOrganizationValidator.validate(laravelInput(ctx), {
            messagesProvider: laravelMessages,
        })
        const actorId = ctx.authUser!.id
        const now = new Date()

        const [row] = await db
            .table('organizations')
            .insert({
                name: data.name,
                type: data.type,
                unique_site_code: generatedSiteCode(data.name),
                is_active: true,
                created_by: actorId,
                updated_by: actorId,
                created_at: now,
                updated_at: now,
            })
            .returning(ORGANIZATION_COLUMNS.map((column) => column.replace('organizations.', '')))

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
        if (data.name !== undefined) changes.name = data.name
        if (data.is_active !== undefined) changes.is_active = data.is_active

        // Eloquent hanya menyimpan kalau ada yang berubah (updated_by ikut
        // dihitung), dan hanya field tercatat yang masuk log.
        const before = organization as unknown as Record<string, unknown>
        const dirty = Object.fromEntries(
            Object.entries(changes).filter(([key, value]) => before[key] !== value)
        )

        let current = organization
        if (Object.keys(dirty).length > 0) {
            const [updated] = await db
                .from('organizations')
                .where('id', organization.id)
                .update({ ...dirty, updated_at: new Date() })
                .returning(
                    ORGANIZATION_COLUMNS.map((column) => column.replace('organizations.', ''))
                )
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
