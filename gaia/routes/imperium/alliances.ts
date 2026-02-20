import { Elysia } from 'elysia'
import { Prisma } from '../../generated/prisma/client.ts'
import { db } from '../../services/db.ts'
import { requireAuth, type AuthenticatedUser } from './auth.ts'
import { gatewayHub } from '../gateway'

const MAX_NAME_LENGTH = 30
const MAX_PREFIX_LENGTH = 30
const MAX_COLOR_LENGTH = 7
const MAX_DESCRIPTION_LENGTH = 200
const MAX_MOTD_LENGTH = 300
const ADMIN_PERMISSION = '*'
const CREATOR_PERMISSIONS = [ADMIN_PERMISSION]

type StatusSetter = { status?: number | string }

const badRequest = (set: StatusSetter, message: string) => {
    set.status = 400
    return { success: false, error: message }
}

const notFound = (set: StatusSetter, message: string) => {
    set.status = 404
    return { success: false, error: message }
}

const handlePrismaError = (error: unknown, set: StatusSetter) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2025') {
            set.status = 404
            return { success: false, error: 'Resource not found' }
        }
        if (error.code === 'P2003') {
            set.status = 404
            return { success: false, error: 'Related resource not found' }
        }
        if (error.code === 'P2000') {
            set.status = 400
            return { success: false, error: 'Input value too long' }
        }

        console.error('gaia imperium alliances prisma error', {
            code: error.code,
            message: error.message,
            meta: error.meta
        })
    } else {
        console.error('gaia imperium alliances unexpected error', error)
    }

    set.status = 500
    return { success: false, error: 'Internal server error' }
}

const forbidden = (set: StatusSetter, message: string) => {
    set.status = 403
    return { success: false, error: message }
}

const normalizeHexColor = (value: unknown): string | null | undefined => {
    if (value === undefined) {
        return undefined
    }

    if (value === null) {
        return null
    }

    if (typeof value !== 'string') {
        return undefined
    }

    const trimmed = value.trim()
    if (trimmed.length === 0) {
        return null
    }

    if (trimmed.length > MAX_COLOR_LENGTH) {
        return undefined
    }

    const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`
    if (!/^#[0-9a-fA-F]{6}$/.test(withHash)) {
        return undefined
    }

    return withHash.toUpperCase()
}

// helper function to check if a user has admin permissions in an alliance
const checkAllianceAdmin = async (userUuid: string, allianceId: string, set: StatusSetter) => {
    const membership = await db.allianceMember.findFirst({
        where: {
            uuid: userUuid,
            allianceId: allianceId,
            membershipState: 'JOINED'
        }
    })

    if (!membership) {
        return forbidden(set, 'You are not a member of this alliance')
    }

    if (!membership.permissions.includes(ADMIN_PERMISSION)) {
        return forbidden(set, 'You do not have permission to perform this action')
    }

    return null // null indicates success
}

export const alliancesRouter = new Elysia({ prefix: '/v1/imperium/alliances' })
    .use(requireAuth)
    .post('/create', async ({ body, set, user }) => {
        const { name, prefix, color, description, motd } = body as {
            name: string
            prefix?: string | null
            color?: string | null
            description: string
            motd: string
        }

        if (!name || !description || !motd) {
            return badRequest(set, 'Missing required fields')
        }
        if (name.length > MAX_NAME_LENGTH) {
            return badRequest(set, `Name must be ${MAX_NAME_LENGTH} characters or less`)
        }
        if (description.length > MAX_DESCRIPTION_LENGTH) {
            return badRequest(set, `Description must be ${MAX_DESCRIPTION_LENGTH} characters or less`)
        }
        if (motd.length > MAX_MOTD_LENGTH) {
            return badRequest(set, `MOTD must be ${MAX_MOTD_LENGTH} characters or less`)
        }

        if (prefix !== undefined && prefix !== null && typeof prefix !== 'string') {
            return badRequest(set, 'Prefix must be a string')
        }

        let normalizedPrefix: string | null | undefined = undefined
        if (prefix !== undefined) {
            if (prefix === null) {
                normalizedPrefix = null
            } else {
                const trimmedPrefix = prefix.trim()
                if (trimmedPrefix.length > MAX_PREFIX_LENGTH) {
                    return badRequest(set, `Prefix must be ${MAX_PREFIX_LENGTH} characters or less`)
                }
                normalizedPrefix = trimmedPrefix.length > 0 ? trimmedPrefix : null
            }
        }

        const normalizedColor = normalizeHexColor(color)
        if (color !== undefined && normalizedColor === undefined) {
            return badRequest(set, 'Color must be a valid hex color (for example #55FF55)')
        }

        if (!user) {
            set.status = 401
            return { success: false, error: 'Unauthorized' }
        }

        try {
            const alliance = await db.$transaction((tx) => {
                return tx.alliance.create({
                    data: {
                        name,
                        ...(normalizedPrefix !== undefined && { prefix: normalizedPrefix }),
                        ...(normalizedColor !== undefined && { color: normalizedColor }),
                        description,
                        motd,
                        ownedBy: user.uuid,
                        members: {
                            create: {
                                uuid: user.uuid,
                                cachedName: user.name,
                                membershipState: 'JOINED',
                                addedBy: user.uuid,
                                permissions: CREATOR_PERMISSIONS
                            }
                        }
                    },
                    include: { members: true }
                })
            })

            return { success: true, alliance }
        } catch (error) {
            return handlePrismaError(error, set)
        }
    })

    .post('/update', async ({ body, set, user }) => {
        const payload = body as {
            allianceId: string
            name?: string
            prefix?: string | null
            color?: string | null
            description?: string
            motd?: string
        }
        const { allianceId, name, prefix, color, description, motd } = payload

        const hasName = Object.prototype.hasOwnProperty.call(payload, 'name')
        const hasPrefix = Object.prototype.hasOwnProperty.call(payload, 'prefix')
        const hasColor = Object.prototype.hasOwnProperty.call(payload, 'color')
        const hasDescription = Object.prototype.hasOwnProperty.call(payload, 'description')
        const hasMotd = Object.prototype.hasOwnProperty.call(payload, 'motd')

        if (!user) {
            set.status = 401
            return { success: false, error: 'Unauthorized' }
        }

        if (!allianceId) {
            return badRequest(set, 'Missing allianceId')
        }

        if (!hasName && !hasPrefix && !hasColor && !hasDescription && !hasMotd) {
            return badRequest(set, 'No fields to update')
        }

        if (name !== undefined) {
            if (!name.trim()) {
                return badRequest(set, 'Name cannot be empty')
            }
            if (name.length > MAX_NAME_LENGTH) {
                return badRequest(set, `Name must be ${MAX_NAME_LENGTH} characters or less`)
            }
        }

        if (description !== undefined) {
            if (!description.trim()) {
                return badRequest(set, 'Description cannot be empty')
            }
            if (description.length > MAX_DESCRIPTION_LENGTH) {
                return badRequest(set, `Description must be ${MAX_DESCRIPTION_LENGTH} characters or less`)
            }
        }

        if (motd !== undefined) {
            if (!motd.trim()) {
                return badRequest(set, 'MOTD cannot be empty')
            }
            if (motd.length > MAX_MOTD_LENGTH) {
                return badRequest(set, `MOTD must be ${MAX_MOTD_LENGTH} characters or less`)
            }
        }

        let normalizedPrefix: string | null | undefined = undefined
        if (hasPrefix) {
            if (prefix !== undefined && prefix !== null && typeof prefix !== 'string') {
                return badRequest(set, 'Prefix must be a string')
            }

            if (prefix === null || prefix === undefined) {
                normalizedPrefix = null
            } else {
                const trimmedPrefix = prefix.trim()
                if (trimmedPrefix.length > MAX_PREFIX_LENGTH) {
                    return badRequest(set, `Prefix must be ${MAX_PREFIX_LENGTH} characters or less`)
                }
                normalizedPrefix = trimmedPrefix.length > 0 ? trimmedPrefix : null
            }
        }

        let normalizedColor: string | null | undefined = undefined
        if (hasColor) {
            normalizedColor = normalizeHexColor(color)
            if (normalizedColor === undefined) {
                return badRequest(set, 'Color must be a valid hex color (for example #55FF55)')
            }
        }

        const authError = await checkAllianceAdmin(user.uuid, allianceId, set)
        if (authError) return authError

        try {
            const alliance = await db.alliance.update({
                where: { id: allianceId },
                data: {
                    ...(name !== undefined && { name: name.trim() }),
                    ...(hasPrefix && { prefix: normalizedPrefix }),
                    ...(hasColor && { color: normalizedColor }),
                    ...(description !== undefined && { description: description.trim() }),
                    ...(motd !== undefined && { motd: motd.trim() })
                },
                include: { members: true }
            })

            await gatewayHub.refreshAllianceMembers(allianceId)
            await gatewayHub.notifyAllianceMembers(allianceId, {
                type: 'alliance.updated',
                data: {
                    allianceId
                }
            })

            return { success: true, alliance }
        } catch (error) {
            return handlePrismaError(error, set)
        }
    })

    .post('/invite-member', async ({ body, set, user }) => {
        const { allianceId, uuid, cachedName, permissions } = body as {
            allianceId: string
            uuid: string
            cachedName: string
            permissions: string[]
        }

        if (!user) {
            set.status = 401
            return { success: false, error: 'Unauthorized' }
        }

        if (!allianceId || !uuid || !cachedName || !permissions) {
            return badRequest(set, 'Missing required fields')
        }
        if (!Array.isArray(permissions)) {
            return badRequest(set, 'Permissions must be an array')
        }

        const authError = await checkAllianceAdmin(user.uuid, allianceId, set)
        if (authError) return authError

        try {
            const member = await db.allianceMember.create({
                data: {
                    uuid,
                    cachedName,
                    addedBy: user.uuid,
                    permissions,
                    allianceId
                    // membershipState defaults to INVITED via Prisma schema
                }
            })

            await gatewayHub.notifyAllianceMembers(allianceId, {
                type: 'alliance.member.invited',
                data: {
                    allianceId,
                    memberId: member.id,
                    uuid,
                    cachedName,
                    addedBy: user.uuid
                }
            })

            return { success: true, member }
        } catch (error) {
            return handlePrismaError(error, set)
        }
    })

    .post('/remove-member', async ({ body, set, user }) => {
        const { memberId } = body as { memberId: string }

        if (!memberId) {
            return badRequest(set, 'Missing memberId')
        }

        // get the member to find their alliance and check permissions
        const member = await db.allianceMember.findUnique({
            where: { id: memberId }
        })

        if (!member) {
            return notFound(set, 'Member not found')
        }

        // check if user has admin permissions in this alliance
        const authError = await checkAllianceAdmin(user!.uuid, member.allianceId, set)
        if (authError) return authError

        try {
            await db.allianceMember.delete({
                where: { id: memberId }
            })

            await gatewayHub.refreshAllianceMembers(member.allianceId)
            await gatewayHub.refreshUserAlliances(member.uuid)
            await gatewayHub.notifyAllianceMembers(member.allianceId, {
                type: 'alliance.member.removed',
                data: {
                    allianceId: member.allianceId,
                    memberId: member.id,
                    uuid: member.uuid
                }
            })

            return { success: true }
        } catch (error) {
            return handlePrismaError(error, set)
        }
    })

    .post('/modify-member', async ({ body, set, user }) => {
        const { memberId, cachedName, permissions } = body as {
            memberId: string
            cachedName?: string
            permissions?: string[]
        }

        if (!memberId) {
            return badRequest(set, 'Missing memberId')
        }
        if (permissions && !Array.isArray(permissions)) {
            return badRequest(set, 'Permissions must be an array')
        }
        if (!cachedName && !permissions) {
            return badRequest(set, 'No fields to update')
        }

        // get the member to find their alliance and check permissions
        const member = await db.allianceMember.findUnique({
            where: { id: memberId }
        })

        if (!member) {
            return notFound(set, 'Member not found')
        }

        // check if user has admin permissions in this alliance
        const authError = await checkAllianceAdmin(user!.uuid, member.allianceId, set)
        if (authError) return authError

        try {
            const member = await db.allianceMember.update({
                where: { id: memberId },
                data: {
                    ...(cachedName && { cachedName }),
                    ...(permissions && { permissions })
                }
            })

            await gatewayHub.notifyAllianceMembers(member.allianceId, {
                type: 'alliance.member.updated',
                data: {
                    allianceId: member.allianceId,
                    memberId: member.id,
                    cachedName: member.cachedName,
                    permissions: member.permissions
                }
            })

            return { success: true, member }
        } catch (error) {
            return handlePrismaError(error, set)
        }
    })

    .post('/delete', async ({ body, set, user }) => {
        const { allianceId } = body as { allianceId: string }

        if (!allianceId) {
            return badRequest(set, 'Missing allianceId')
        }

        // check if user has admin permissions
        const authError = await checkAllianceAdmin(user!.uuid, allianceId, set)
        if (authError) return authError

        try {
            await db.alliance.delete({
                where: { id: allianceId }
            })

            return { success: true }
        } catch (error) {
            return handlePrismaError(error, set)
        }
    })

    .get('/@self', async ({ set, user }) => {
        if (!user) {
            set.status = 401
            return { success: false, error: 'Unauthorized' }
        }

        try {
            // find all joined alliances for the current user
            const memberships = await db.allianceMember.findMany({
                where: {
                    uuid: user.uuid,
                    membershipState: 'JOINED'
                },
                include: {
                    alliance: {
                        include: {
                            members: true
                        }
                    }
                }
            })

            const alliances = memberships.map(m => m.alliance)
            return { success: true, alliances }
        } catch (error) {
            return handlePrismaError(error, set)
        }
    })

    .get('/@self/invites', async ({ set, user }) => {
        if (!user) {
            set.status = 401
            return { success: false, error: 'Unauthorized' }
        }

        try {
            const memberships = await db.allianceMember.findMany({
                where: {
                    uuid: user.uuid,
                    membershipState: 'INVITED'
                },
                include: {
                    alliance: {
                        include: {
                            members: true
                        }
                    }
                }
            })

            const alliances = memberships.map((membership) => membership.alliance)
            return { success: true, alliances }
        } catch (error) {
            return handlePrismaError(error, set)
        }
    })

    .get('/:id', async ({ params: { id }, set, user }) => {
        const alliance = await db.alliance.findUnique({
            where: { id },
            include: { members: true }
        })

        if (!alliance) {
            return notFound(set, 'Alliance not found')
        }

        return { success: true, alliance }
    })

    .post('/@self/join', async ({ body, set, user }) => {
        const { allianceId } = body as { allianceId: string }

        if (!user) {
            set.status = 401
            return { success: false, error: 'Unauthorized' }
        }

        if (!allianceId) {
            return badRequest(set, 'Missing allianceId')
        }

        try {
            // find the member record for this user in the specified alliance
            const member = await db.allianceMember.findFirst({
                where: {
                    uuid: user.uuid,
                    allianceId: allianceId,
                    membershipState: 'INVITED'
                }
            })

            if (!member) {
                return notFound(set, 'No pending invitation found for this alliance')
            }

            // update the membership state to JOINED
            const updatedMember = await db.allianceMember.update({
                where: { id: member.id },
                data: { membershipState: 'JOINED' }
            })

            await gatewayHub.refreshAllianceMembers(allianceId)
            await gatewayHub.refreshUserAlliances(user.uuid)
            await gatewayHub.notifyAllianceMembers(allianceId, {
                type: 'alliance.member.joined',
                data: {
                    allianceId,
                    memberId: updatedMember.id,
                    uuid: updatedMember.uuid,
                    cachedName: updatedMember.cachedName
                }
            })

            return { success: true, member: updatedMember }
        } catch (error) {
            return handlePrismaError(error, set)
        }
    })

    .post('/@self/reject', async ({ body, set, user }) => {
        const { allianceId } = body as { allianceId: string }

        if (!user) {
            set.status = 401
            return { success: false, error: 'Unauthorized' }
        }

        if (!allianceId) {
            return badRequest(set, 'Missing allianceId')
        }

        try {
            const member = await db.allianceMember.findFirst({
                where: {
                    uuid: user.uuid,
                    allianceId: allianceId,
                    membershipState: 'INVITED'
                }
            })

            if (!member) {
                return notFound(set, 'No pending invitation found for this alliance')
            }

            const updatedMember = await db.allianceMember.update({
                where: { id: member.id },
                data: { membershipState: 'DECLINED' }
            })

            await gatewayHub.refreshAllianceMembers(allianceId)
            await gatewayHub.refreshUserAlliances(user.uuid)
            await gatewayHub.notifyAllianceMembers(allianceId, {
                type: 'alliance.member.declined',
                data: {
                    allianceId,
                    memberId: updatedMember.id,
                    uuid: updatedMember.uuid,
                    cachedName: updatedMember.cachedName
                }
            })

            return { success: true, member: updatedMember }
        } catch (error) {
            return handlePrismaError(error, set)
        }
    })