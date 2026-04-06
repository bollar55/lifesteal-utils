import { Elysia } from 'elysia'
import { Prisma } from '../generated/prisma/client.ts'
import { db } from '../services/db.ts'
import { gatewayHub } from './gateway.ts'
import { requireAuth } from './imperium/auth.ts'

const ALLIANCE_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ALLIANCE_ID_LENGTH = 3
const ALLIANCE_NAME_MAX_LENGTH = 64
const ALLIANCE_DESCRIPTION_MAX_LENGTH = 1024
const LIST_NAME_MAX_LENGTH = 64
const LIST_PREFIX_MAX_LENGTH = 256
const SUBSCRIBE_NOT_FOUND_ERROR = "Whoops, this alliance code doesn't exist anymore!"
const SUBSCRIBE_FORBIDDEN_ERROR = "Only already added users can subscribe to this alliance. Please contact your alliance's admin to get added first."

type StatusSetter = { status?: number | string }

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

const badRequest = (set: StatusSetter, message: string) => {
    set.status = 400
    return { success: false, error: message }
}

const unauthorized = (set: StatusSetter, message: string) => {
    set.status = 401
    return { success: false, error: message }
}

const forbidden = (set: StatusSetter, message: string) => {
    set.status = 403
    return { success: false, error: message }
}

const notFound = (set: StatusSetter, message: string) => {
    set.status = 404
    return { success: false, error: message }
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
            set.add(member.uuid.toLowerCase())
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

const validateDataPayload = (raw: unknown, set: StatusSetter): AllianceDataPayload | null => {
    if (!raw || typeof raw !== 'object') {
        badRequest(set, 'Alliance data must be an object')
        return null
    }

    const payload = raw as Partial<AllianceDataPayload>

    if (typeof payload.name !== 'string' || payload.name.trim().length === 0 || payload.name.length > ALLIANCE_NAME_MAX_LENGTH) {
        badRequest(set, `Alliance name must be between 1 and ${ALLIANCE_NAME_MAX_LENGTH} characters`)
        return null
    }

    if (typeof payload.description !== 'string' || payload.description.length > ALLIANCE_DESCRIPTION_MAX_LENGTH) {
        badRequest(set, `Alliance description must be ${ALLIANCE_DESCRIPTION_MAX_LENGTH} characters or less`)
        return null
    }

    if (typeof payload.color !== 'number' || !Number.isInteger(payload.color) || payload.color < 0 || payload.color > 0xffffff) {
        badRequest(set, 'Alliance color must be an integer between 0 and 16777215')
        return null
    }

    if (!Array.isArray(payload.lists) || payload.lists.length === 0) {
        badRequest(set, 'Alliance lists must be a non-empty array')
        return null
    }

    const normalizedLists: AllianceDataList[] = []
    for (const list of payload.lists) {
        if (!list || typeof list !== 'object') {
            badRequest(set, 'Invalid list object in alliance data')
            return null
        }

        const typed = list as Partial<AllianceDataList>
        if (typeof typed.id !== 'string' || typed.id.trim().length === 0) {
            badRequest(set, 'Each list must have an id')
            return null
        }

        if (typeof typed.name !== 'string' || typed.name.trim().length === 0 || typed.name.length > LIST_NAME_MAX_LENGTH) {
            badRequest(set, `Each list name must be between 1 and ${LIST_NAME_MAX_LENGTH} characters`)
            return null
        }

        if (typeof typed.prefix !== 'string' || typed.prefix.length > LIST_PREFIX_MAX_LENGTH) {
            badRequest(set, `Each list prefix must be ${LIST_PREFIX_MAX_LENGTH} characters or less`)
            return null
        }

        const normalizedPrefixColor = typeof typed.prefixColor === 'number' ? typed.prefixColor : payload.color
        if (typeof normalizedPrefixColor !== 'number' || !Number.isInteger(normalizedPrefixColor) || normalizedPrefixColor < 0 || normalizedPrefixColor > 0xffffff) {
            badRequest(set, 'Each list prefixColor must be an integer between 0 and 16777215')
            return null
        }

        if (!Array.isArray(typed.members)) {
            badRequest(set, 'Each list must contain a members array')
            return null
        }

        const members: AllianceDataMember[] = []
        for (const member of typed.members) {
            if (!member || typeof member !== 'object') {
                badRequest(set, 'Invalid member object in list')
                return null
            }
            const typedMember = member as Partial<AllianceDataMember>
            if (!isReasonableUuid(typedMember.uuid)) {
                badRequest(set, 'Member uuid must be a valid UUID')
                return null
            }
            if (typeof typedMember.addedAt !== 'number' || !Number.isFinite(typedMember.addedAt)) {
                badRequest(set, 'Member addedAt must be a number')
                return null
            }
            members.push({
                uuid: typedMember.uuid.trim().toLowerCase(),
                addedAt: typedMember.addedAt
            })
        }

        normalizedLists.push({
            id: typed.id.trim(),
            name: typed.name.trim(),
            prefix: typed.prefix,
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
    .post('/', async ({ body, set, user }) => {
        if (!user) {
            return unauthorized(set, 'Unauthorized')
        }

        const typedBody = body as {
            subscriptionPermission?: string
            data?: unknown
        }

        const data = validateDataPayload(typedBody.data, set)
        if (!data) {
            return
        }

        const id = await createUniqueAllianceId()
        const subscriptionPermission = parseSubscriptionPermission(typedBody.subscriptionPermission)

        const created = await db.alliance.create({
            data: {
                id,
                owner: user.uuid,
                subscriptionPermission,
                data: data as unknown as Prisma.InputJsonValue
            }
        })

        await db.allianceSubscription.upsert({
            where: {
                userId_allianceId: {
                    userId: user.uuid,
                    allianceId: id
                }
            },
            update: {},
            create: {
                userId: user.uuid,
                allianceId: id
            }
        })

        set.status = 201
        return {
            success: true,
            alliance: toAllianceResponse(created)
        }
    })
    .get('/subscriptions', async ({ set, user }) => {
        if (!user) {
            return unauthorized(set, 'Unauthorized')
        }

        const subscriptions = await db.allianceSubscription.findMany({
            where: {
                userId: user.uuid,
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
    })
    .get('/:id', async ({ params, set, user }) => {
        if (!user) {
            return unauthorized(set, 'Unauthorized')
        }

        const { alliance, error } = await requireAllianceReadAccess(params.id, user.uuid, set)
        if (error || !alliance) {
            return error
        }

        return {
            success: true,
            alliance: toAllianceResponse(alliance)
        }
    })
    .put('/:id/data', async ({ params, body, set, user }) => {
        if (!user) {
            return unauthorized(set, 'Unauthorized')
        }

        const alliance = await db.alliance.findFirst({
            where: {
                id: params.id,
                deletedAt: null
            }
        })

        if (!alliance) {
            return notFound(set, 'Alliance not found')
        }

        if (alliance.owner.toLowerCase() !== user.uuid.toLowerCase()) {
            return forbidden(set, 'Only the owner can edit alliance data')
        }

        const typedBody = body as {
            subscriptionPermission?: string
            data?: unknown
        }
        const data = validateDataPayload(typedBody.data, set)
        if (!data) {
            return
        }

        const updated = await db.alliance.update({
            where: {
                id: alliance.id
            },
            data: {
                subscriptionPermission: parseSubscriptionPermission(typedBody.subscriptionPermission),
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
                    username: user.name
                }
            })
        }

        set.status = 204
        return {
            success: true,
            alliance: toAllianceResponse(updated)
        }
    })
    .delete('/:id', async ({ params, set, user }) => {
        if (!user) {
            return unauthorized(set, 'Unauthorized')
        }

        const alliance = await db.alliance.findFirst({
            where: {
                id: params.id,
                deletedAt: null
            }
        })

        if (!alliance) {
            return notFound(set, 'Alliance not found')
        }

        if (alliance.owner.toLowerCase() !== user.uuid.toLowerCase()) {
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
            await gatewayHub.notifyUser(subscription.userId, {
                type: 'alliance.deleted',
                data: {
                    allianceId: alliance.id,
                    allianceName: (alliance.data as AllianceDataPayload).name,
                    username: user.name
                }
            })
        }

        set.status = 204
        return {
            success: true
        }
    })
    .post('/:id/subscribe', async ({ params, set, user }) => {
        if (!user) {
            return unauthorized(set, 'Unauthorized')
        }

        const alliance = await db.alliance.findFirst({
            where: {
                id: params.id,
                deletedAt: null
            }
        })

        if (!alliance) {
            console.info('[gaia][alliances] subscribe failed: alliance not found', {
                allianceId: params.id,
                userUuid: user.uuid,
                userName: user.name
            })
            return notFound(set, SUBSCRIBE_NOT_FOUND_ERROR)
        }

        const data = alliance.data as AllianceDataPayload
        if (alliance.subscriptionPermission === 'MEMBERS' && !includesMember(data, user.uuid)) {
            const normalizedUserUuid = normalizeUuidForComparison(user.uuid)
            const memberUuidSamples = data.lists
                .flatMap((list) => list.members.map((member) => member.uuid))
                .slice(0, 8)
            const normalizedMemberUuidSamples = memberUuidSamples.map((candidate) => normalizeUuidForComparison(candidate))
            console.warn('[gaia][alliances] subscribe denied: user not in member list', {
                allianceId: alliance.id,
                allianceName: data.name,
                subscriptionPermission: alliance.subscriptionPermission,
                userUuid: user.uuid,
                normalizedUserUuid,
                userName: user.name,
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
                    userId: user.uuid,
                    allianceId: alliance.id
                }
            },
            update: {},
            create: {
                userId: user.uuid,
                allianceId: alliance.id
            }
        })

        return {
            success: true,
            alliance: toAllianceResponse(alliance),
            memberCount: uniqueMemberCount(data)
        }
    })
    .delete('/:id/subscribe', async ({ params, set, user }) => {
        if (!user) {
            return unauthorized(set, 'Unauthorized')
        }

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
                userId: user.uuid,
                allianceId: alliance.id
            }
        })

        await gatewayHub.notifyUser(user.uuid, {
            type: 'alliance.subscription.revoked',
            data: {
                allianceId: alliance.id,
                allianceName: (alliance.data as AllianceDataPayload).name,
                username: user.name
            }
        })

        set.status = 204
        return {
            success: true
        }
    })
