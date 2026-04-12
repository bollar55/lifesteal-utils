import { Elysia, t } from 'elysia'
import { Prisma } from '../generated/prisma/client.ts'
import { db } from '../services/db.ts'
import { badRequest, forbidden, notFound, type StatusSetter } from './utils/http.ts'
import { gatewayHub } from './gateway.ts'
import { requireAuth, type AuthenticatedUser } from './imperium/auth.ts'

const ALLIANCE_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ALLIANCE_ID_LENGTH = 3
const ALLIANCE_NAME_MAX_LENGTH = 64
const ALLIANCE_DESCRIPTION_MAX_LENGTH = 1024
const LIST_NAME_MAX_LENGTH = 64
const LIST_PREFIX_MAX_LENGTH = 256
const SUBSCRIBE_NOT_FOUND_ERROR = "Whoops, this alliance code doesn't exist anymore!"
const SUBSCRIBE_FORBIDDEN_ERROR = "Only already added users can subscribe to this alliance. Please contact your alliance's admin to get added first."

type AllianceDataMember = {
    uuid: string
    addedAt: number
}

type AllianceDataList = {
    id: string
    name: string
    prefix: string
    prefixColor: number
    members: AllianceDataMember[]
}

type AllianceDataPayload = {
    name: string
    description: string
    color: number
    lists: AllianceDataList[]
}

const parseSubscriptionPermission = (value: unknown) => {
    if (typeof value !== 'string') {
        return 'MEMBERS' as const
    }
    if (value.toUpperCase() === 'ANYONE') {
        return 'ANYONE' as const
    }
    return 'MEMBERS' as const
}

type AllianceDataInputMember = {
    uuid: string
    addedAt: number
}

type AllianceDataInputList = {
    id: string
    name: string
    prefix: string
    prefixColor?: number
    members: AllianceDataInputMember[]
}

type AllianceDataInputPayload = {
    name: string
    description: string
    color: number
    lists: AllianceDataInputList[]
}

const allianceIdParamSchema = t.Object({
    id: t.String({ minLength: ALLIANCE_ID_LENGTH, maxLength: ALLIANCE_ID_LENGTH })
})

const allianceMemberInputSchema = t.Object({
    uuid: t.String({ minLength: 1, maxLength: 64 }),
    addedAt: t.Number()
})

const allianceListInputSchema = t.Object({
    id: t.String({ minLength: 1, maxLength: 64 }),
    name: t.String({ minLength: 1, maxLength: LIST_NAME_MAX_LENGTH }),
    prefix: t.String({ maxLength: LIST_PREFIX_MAX_LENGTH }),
    prefixColor: t.Optional(t.Number({ minimum: 0, maximum: 0xffffff, multipleOf: 1 })),
    members: t.Array(allianceMemberInputSchema)
})

const allianceDataInputSchema = t.Object({
    name: t.String({ minLength: 1, maxLength: ALLIANCE_NAME_MAX_LENGTH }),
    description: t.String({ maxLength: ALLIANCE_DESCRIPTION_MAX_LENGTH }),
    color: t.Number({ minimum: 0, maximum: 0xffffff, multipleOf: 1 }),
    lists: t.Array(allianceListInputSchema, { minItems: 1 })
})

const allianceUpsertBodySchema = t.Object({
    subscriptionPermission: t.Optional(t.String()),
    data: allianceDataInputSchema
})

const allianceResponseSchema = t.Object({
    id: t.String(),
    owner: t.String(),
    created_at: t.String(),
    updated_at: t.String(),
    subscription_permission: t.Union([t.Literal('ANYONE'), t.Literal('MEMBERS')]),
    data: t.Unknown()
})

const allianceSuccessSchema = t.Object({
    success: t.Literal(true),
    alliance: allianceResponseSchema
})

const allianceSubscriptionsSuccessSchema = t.Object({
    success: t.Literal(true),
    alliances: t.Array(allianceResponseSchema)
})

const allianceSubscribeSuccessSchema = t.Object({
    success: t.Literal(true),
    alliance: allianceResponseSchema,
    memberCount: t.Number()
})

const allianceErrorSchema = t.Object({
    success: t.Literal(false),
    error: t.String()
})

const isReasonableUuid = (uuid: unknown) => {
    return normalizeUuidForComparison(uuid) !== null
}

const normalizeUuidForComparison = (uuid: unknown) => {
    if (typeof uuid !== 'string') {
        return null
    }
    const normalized = uuid.trim().toLowerCase().replace(/-/g, '')
    if (!/^[0-9a-f]{32}$/.test(normalized)) {
        return null
    }
    return normalized
}

const uniqueMemberCount = (data: AllianceDataPayload) => {
    const set = new Set<string>()
    for (const list of data.lists) {
        for (const member of list.members) {
            const normalized = normalizeUuidForComparison(member.uuid)
            if (normalized) {
                set.add(normalized)
            }
        }
    }
    return set.size
}

const includesMember = (data: AllianceDataPayload, uuid: string) => {
    const normalizedNeedle = normalizeUuidForComparison(uuid)
    if (!normalizedNeedle) {
        return false
    }
    for (const list of data.lists) {
        for (const member of list.members) {
            const normalizedMemberUuid = normalizeUuidForComparison(member.uuid)
            if (normalizedMemberUuid === normalizedNeedle) {
                return true
            }
        }
    }
    return false
}

const validateDataPayload = (payload: AllianceDataInputPayload, set: StatusSetter): AllianceDataPayload | null => {
    if (payload.name.trim().length === 0) {
        badRequest(set, `Alliance name must be between 1 and ${ALLIANCE_NAME_MAX_LENGTH} characters`)
        return null
    }

    if (payload.description.length > ALLIANCE_DESCRIPTION_MAX_LENGTH) {
        badRequest(set, `Alliance description must be ${ALLIANCE_DESCRIPTION_MAX_LENGTH} characters or less`)
        return null
    }

    if (!Number.isInteger(payload.color) || payload.color < 0 || payload.color > 0xffffff) {
        badRequest(set, 'Alliance color must be an integer between 0 and 16777215')
        return null
    }

    if (payload.lists.length === 0) {
        badRequest(set, 'Alliance lists must be a non-empty array')
        return null
    }

    const normalizedLists: AllianceDataList[] = []
    for (const list of payload.lists) {
        if (list.id.trim().length === 0) {
            badRequest(set, 'Each list must have an id')
            return null
        }

        if (list.name.trim().length === 0 || list.name.length > LIST_NAME_MAX_LENGTH) {
            badRequest(set, `Each list name must be between 1 and ${LIST_NAME_MAX_LENGTH} characters`)
            return null
        }

        if (list.prefix.length > LIST_PREFIX_MAX_LENGTH) {
            badRequest(set, `Each list prefix must be ${LIST_PREFIX_MAX_LENGTH} characters or less`)
            return null
        }

        const normalizedPrefixColor = typeof list.prefixColor === 'number' ? list.prefixColor : payload.color
        if (typeof normalizedPrefixColor !== 'number' || !Number.isInteger(normalizedPrefixColor) || normalizedPrefixColor < 0 || normalizedPrefixColor > 0xffffff) {
            badRequest(set, 'Each list prefixColor must be an integer between 0 and 16777215')
            return null
        }

        const members: AllianceDataMember[] = []
        for (const member of list.members) {
            if (!isReasonableUuid(member.uuid)) {
                badRequest(set, 'Member uuid must be a valid UUID')
                return null
            }
            if (!Number.isFinite(member.addedAt)) {
                badRequest(set, 'Member addedAt must be a number')
                return null
            }
            members.push({
                uuid: member.uuid.trim().toLowerCase(),
                addedAt: member.addedAt
            })
        }

        normalizedLists.push({
            id: list.id.trim(),
            name: list.name.trim(),
            prefix: list.prefix,
            prefixColor: normalizedPrefixColor,
            members
        })
    }

    return {
        name: payload.name.trim(),
        description: payload.description,
        color: payload.color,
        lists: normalizedLists
    }
}

const toAllianceResponse = (alliance: {
    id: string
    owner: string
    createdAt: Date
    updatedAt: Date
    subscriptionPermission: 'ANYONE' | 'MEMBERS'
    data: Prisma.JsonValue
}) => ({
    id: alliance.id,
    owner: alliance.owner,
    created_at: alliance.createdAt.toISOString(),
    updated_at: alliance.updatedAt.toISOString(),
    subscription_permission: alliance.subscriptionPermission,
    data: alliance.data
})

const tryReadAllianceData = (value: Prisma.JsonValue) => {
    if (!value || typeof value !== 'object') {
        return null
    }

    const payload = value as Partial<AllianceDataPayload>
    if (typeof payload.name !== 'string' || !Array.isArray(payload.lists)) {
        return null
    }

    return payload as AllianceDataPayload
}

const randomAllianceId = () => {
    let id = ''
    for (let i = 0; i < ALLIANCE_ID_LENGTH; i++) {
        id += ALLIANCE_ID_ALPHABET[Math.floor(Math.random() * ALLIANCE_ID_ALPHABET.length)]
    }
    return id
}

const createUniqueAllianceId = async () => {
    for (let attempt = 0; attempt < 25; attempt++) {
        const candidate = randomAllianceId()
        const existing = await db.alliance.findUnique({
            where: { id: candidate },
            select: { id: true }
        })
        if (!existing) {
            return candidate
        }
    }
    throw new Error('Failed to generate unique alliance id')
}

const requireAllianceReadAccess = async (allianceId: string, userUuid: string, set: StatusSetter) => {
    const alliance = await db.alliance.findFirst({
        where: {
            id: allianceId,
            deletedAt: null
        }
    })

    if (!alliance) {
        return { error: notFound(set, 'Alliance not found'), alliance: null }
    }

    if (alliance.owner.toLowerCase() === userUuid.toLowerCase()) {
        return { alliance, error: null }
    }

    const hasSubscription = await db.allianceSubscription.findFirst({
        where: {
            allianceId: alliance.id,
            userId: userUuid
        },
        select: { id: true }
    })

    if (!hasSubscription) {
        return { error: forbidden(set, 'You are not subscribed to this alliance'), alliance: null }
    }

    return { alliance, error: null }
}

export const alliancesRouter = new Elysia({ prefix: '/v1/alliances' })
    .use(requireAuth)
    .model({
        allianceIdParam: allianceIdParamSchema,
        allianceUpsertBody: allianceUpsertBodySchema,
        allianceSuccess: allianceSuccessSchema,
        allianceSubscriptionsSuccess: allianceSubscriptionsSuccessSchema,
        allianceSubscribeSuccess: allianceSubscribeSuccessSchema,
        allianceError: allianceErrorSchema
    })
    .onError(({ code, set }) => {
        if (code === 'VALIDATION') {
            return badRequest(set, 'Invalid request payload')
        }
    })
    .post('/', async ({ body, set, user }) => {
        const authUser = user as AuthenticatedUser
        const data = validateDataPayload(body.data, set)
        if (!data) {
            return
        }

        const id = await createUniqueAllianceId()
        const subscriptionPermission = parseSubscriptionPermission(body.subscriptionPermission)

        const created = await db.alliance.create({
            data: {
                id,
                owner: authUser.uuid,
                subscriptionPermission,
                data: data as unknown as Prisma.InputJsonValue
            }
        })

        await db.allianceSubscription.upsert({
            where: {
                userId_allianceId: {
                    userId: authUser.uuid,
                    allianceId: id
                }
            },
            update: {},
            create: {
                userId: authUser.uuid,
                allianceId: id
            }
        })

        set.status = 201
        return {
            success: true,
            alliance: toAllianceResponse(created)
        }
    }, {
        body: 'allianceUpsertBody',
        response: {
            201: 'allianceSuccess',
            400: 'allianceError',
            401: 'allianceError'
        }
    })
    .get('/subscriptions', async ({ set, user }) => {
        const authUser = user as AuthenticatedUser

        const subscriptions = await db.allianceSubscription.findMany({
            where: {
                userId: authUser.uuid,
                alliance: {
                    deletedAt: null
                }
            },
            include: {
                alliance: true
            },
            orderBy: {
                subscribedAt: 'asc'
            }
        })

        return {
            success: true,
            alliances: subscriptions.map((subscription) => toAllianceResponse(subscription.alliance))
        }
    }, {
        response: {
            200: 'allianceSubscriptionsSuccess',
            401: 'allianceError'
        }
    })
    .get('/:id', async ({ params, set, user }) => {
        const authUser = user as AuthenticatedUser

        const { alliance, error } = await requireAllianceReadAccess(params.id, authUser.uuid, set)
        if (error || !alliance) {
            return error
        }

        return {
            success: true,
            alliance: toAllianceResponse(alliance)
        }
    }, {
        params: 'allianceIdParam',
        response: {
            200: 'allianceSuccess',
            401: 'allianceError',
            403: 'allianceError',
            404: 'allianceError'
        }
    })
    .put('/:id/data', async ({ params, body, set, user }) => {
        const authUser = user as AuthenticatedUser

        const alliance = await db.alliance.findFirst({
            where: {
                id: params.id,
                deletedAt: null
            }
        })

        if (!alliance) {
            return notFound(set, 'Alliance not found')
        }

        if (alliance.owner.toLowerCase() !== authUser.uuid.toLowerCase()) {
            return forbidden(set, 'Only the owner can edit alliance data')
        }

        const data = validateDataPayload(body.data, set)
        if (!data) {
            return
        }

        const updated = await db.alliance.update({
            where: {
                id: alliance.id
            },
            data: {
                subscriptionPermission: parseSubscriptionPermission(body.subscriptionPermission),
                data: data as unknown as Prisma.InputJsonValue
            }
        })

        const subscriptions = await db.allianceSubscription.findMany({
            where: { allianceId: alliance.id },
            select: { userId: true }
        })

        for (const subscription of subscriptions) {
            await gatewayHub.notifyUser(subscription.userId, {
                type: 'alliance.updated',
                data: {
                    allianceId: alliance.id,
                    allianceName: data.name,
                    username: authUser.name
                }
            })
        }

        return {
            success: true,
            alliance: toAllianceResponse(updated)
        }
    }, {
        params: 'allianceIdParam',
        body: 'allianceUpsertBody',
        response: {
            200: 'allianceSuccess',
            400: 'allianceError',
            401: 'allianceError',
            403: 'allianceError',
            404: 'allianceError'
        }
    })
    .delete('/:id', async ({ params, set, user }) => {
        const authUser = user as AuthenticatedUser

        const alliance = await db.alliance.findFirst({
            where: {
                id: params.id,
                deletedAt: null
            }
        })

        if (!alliance) {
            return notFound(set, 'Alliance not found')
        }

        if (alliance.owner.toLowerCase() !== authUser.uuid.toLowerCase()) {
            return forbidden(set, 'Only the owner can delete this alliance')
        }

        await db.alliance.update({
            where: { id: alliance.id },
            data: {
                deletedAt: new Date()
            }
        })

        const subscriptions = await db.allianceSubscription.findMany({
            where: { allianceId: alliance.id },
            select: { userId: true }
        })

        for (const subscription of subscriptions) {
            const allianceData = tryReadAllianceData(alliance.data)
            await gatewayHub.notifyUser(subscription.userId, {
                type: 'alliance.deleted',
                data: {
                    allianceId: alliance.id,
                    allianceName: allianceData?.name ?? alliance.id,
                    username: authUser.name
                }
            })
        }

        set.status = 204
    }, {
        params: 'allianceIdParam',
        response: {
            204: t.Void(),
            401: 'allianceError',
            403: 'allianceError',
            404: 'allianceError'
        }
    })
    .post('/:id/subscribe', async ({ params, set, user }) => {
        const authUser = user as AuthenticatedUser

        const alliance = await db.alliance.findFirst({
            where: {
                id: params.id,
                deletedAt: null
            }
        })

        if (!alliance) {
            console.info('[gaia][alliances] subscribe failed: alliance not found', {
                allianceId: params.id,
                userUuid: authUser.uuid,
                userName: authUser.name
            })
            return notFound(set, SUBSCRIBE_NOT_FOUND_ERROR)
        }

        const data = alliance.data as AllianceDataPayload
        if (alliance.subscriptionPermission === 'MEMBERS' && !includesMember(data, authUser.uuid)) {
            const normalizedUserUuid = normalizeUuidForComparison(authUser.uuid)
            const memberUuidSamples = data.lists
                .flatMap((list) => list.members.map((member) => member.uuid))
                .slice(0, 8)
            const normalizedMemberUuidSamples = memberUuidSamples.map((candidate) => normalizeUuidForComparison(candidate))
            console.warn('[gaia][alliances] subscribe denied: user not in member list', {
                allianceId: alliance.id,
                allianceName: data.name,
                subscriptionPermission: alliance.subscriptionPermission,
                userUuid: authUser.uuid,
                normalizedUserUuid,
                userName: authUser.name,
                totalLists: data.lists.length,
                totalMembers: uniqueMemberCount(data),
                memberUuidSamples,
                normalizedMemberUuidSamples
            })
            return forbidden(set, SUBSCRIBE_FORBIDDEN_ERROR)
        }

        await db.allianceSubscription.upsert({
            where: {
                userId_allianceId: {
                    userId: authUser.uuid,
                    allianceId: alliance.id
                }
            },
            update: {},
            create: {
                userId: authUser.uuid,
                allianceId: alliance.id
            }
        })

        return {
            success: true,
            alliance: toAllianceResponse(alliance),
            memberCount: uniqueMemberCount(data)
        }
    }, {
        params: 'allianceIdParam',
        response: {
            200: 'allianceSubscribeSuccess',
            401: 'allianceError',
            403: 'allianceError',
            404: 'allianceError'
        }
    })
    .delete('/:id/subscribe', async ({ params, set, user }) => {
        const authUser = user as AuthenticatedUser

        const alliance = await db.alliance.findFirst({
            where: {
                id: params.id,
                deletedAt: null
            }
        })

        if (!alliance) {
            return notFound(set, 'Alliance not found')
        }

        await db.allianceSubscription.deleteMany({
            where: {
                userId: authUser.uuid,
                allianceId: alliance.id
            }
        })

        const allianceData = tryReadAllianceData(alliance.data)
        await gatewayHub.notifyUser(authUser.uuid, {
            type: 'alliance.subscription.revoked',
            data: {
                allianceId: alliance.id,
                allianceName: allianceData?.name ?? alliance.id,
                username: authUser.name
            }
        })

        set.status = 204
    }, {
        params: 'allianceIdParam',
        response: {
            204: t.Void(),
            401: 'allianceError',
            404: 'allianceError'
        }
    })
