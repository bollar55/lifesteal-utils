import { Elysia, t } from 'elysia'
import { jwt } from '@elysiajs/jwt'
import { badRequest, forbidden, serverError } from '../utils/http.ts'
import { extractBearerToken } from '../utils/request.ts'

export const JWT_SECRET_ENV = 'GAIA_JWT_SECRET'
export const JWT_ISSUER = 'gaia.candycup.dev'
export const JWT_TTL_SECONDS = 60 * 60 * 24 * 14
const JWT_TTL_MS = JWT_TTL_SECONDS * 1000

const SESSION_SERVER_URL = 'https://sessionserver.mojang.com/session/minecraft/hasJoined'

const confirmHandshakeBodySchema = t.Object({
    serverId: t.String({ minLength: 1 }),
    username: t.String({ minLength: 1, maxLength: 30 })
})

const errorResponseSchema = t.Object({
    success: t.Literal(false),
    error: t.String()
})

const confirmHandshakeSuccessSchema = t.Object({
    success: t.Literal(true),
    token: t.String(),
    profile: t.Object({
        id: t.String(),
        name: t.String()
    }),
    expiresInMs: t.Number()
})

export type AuthenticatedUser = {
    uuid: string
    name: string
}

type GaiaJwtPayload = {
    uuid: string
    name: string
}

const jwtPayloadSchema = t.Object({
    uuid: t.String(),
    name: t.String(),
    iss: t.Optional(t.String()),
    iat: t.Optional(t.Number()),
    exp: t.Optional(t.Number())
})

export const gaiaJwtPlugin = new Elysia({ name: 'gaia-jwt-plugin' }).use(
    jwt({
        name: 'gaiaJwt',
        secret: process.env[JWT_SECRET_ENV] ?? 'missing-gaia-jwt-secret',
        iss: JWT_ISSUER,
        exp: `${JWT_TTL_SECONDS}s`,
        schema: jwtPayloadSchema
    })
)

const getGaiaJwt = () => {
    return (gaiaJwtPlugin as unknown as {
        singleton: {
            decorator: {
                gaiaJwt: {
                    verify: (token: string) => Promise<false | GaiaJwtPayload>
                }
            }
        }
    }).singleton.decorator.gaiaJwt
}

export const verifyGaiaToken = async (token: string): Promise<AuthenticatedUser | null> => {
    if (!process.env[JWT_SECRET_ENV]) {
        return null
    }

    const payload = await getGaiaJwt().verify(token)
    if (!payload) {
        return null
    }

    return {
        uuid: payload.uuid,
        name: payload.name
    }
}

export const requireAuth = new Elysia({ name: 'auth-guard' })
    .use(gaiaJwtPlugin)
    .derive(async ({ request }) => {
        const token = extractBearerToken(request.headers.get('authorization'))
        if (!token) {
            return {
                user: null as AuthenticatedUser | null
            }
        }

        const user = await verifyGaiaToken(token)
        if (!user) {
            return {
                user: null as AuthenticatedUser | null
            }
        }

        return {
            user
        }
    })
    .onBeforeHandle(({ user, set }) => {
        if (!user) {
            set.status = 401
            return { success: false, error: 'Missing or invalid authorization header' }
        }
    })
    // keep auth checks scoped to routers that explicitly .use(requireAuth)
    .as('scoped')

type MojangProfile = {
    id: string
    name: string
    properties?: Array<{ name: string; value: string; signature?: string }>
}

const fetchMojangProfile = async (username: string, serverId: string) => {
    const url = new URL(SESSION_SERVER_URL)
    url.searchParams.set('username', username)
    url.searchParams.set('serverId', serverId)

    const response = await fetch(url)
    if (response.status === 204) {
        return null
    }
    if (!response.ok) {
        throw new Error(`mojang sessionserver error: ${response.status}`)
    }

    return (await response.json()) as MojangProfile
}

export const authRouter = new Elysia({ prefix: '/v1/imperium/auth' })
    .use(gaiaJwtPlugin)
    .model({
        confirmHandshakeBody: confirmHandshakeBodySchema,
        confirmHandshakeSuccess: confirmHandshakeSuccessSchema,
        authError: errorResponseSchema
    })
    .onError(({ code, set }) => {
        if (code === 'VALIDATION') {
            set.status = 400
            return {
                success: false,
                error: 'Missing required fields'
            }
        }
    })
    .post('/confirm-handshake', async ({ body, set, gaiaJwt }) => {
        const { serverId, username } = body
        const normalizedServerId = serverId?.trim()
        const normalizedUsername = username?.trim()

        if (!normalizedServerId || !normalizedUsername) {
            return badRequest(set, 'Missing required fields')
        }

        // validate that the server id has the expected prefix
        if (!normalizedServerId.startsWith('lsu-gaia-')) {
            return badRequest(set, 'Invalid server id format')
        }

        let mojangProfile: MojangProfile | null
        try {
            mojangProfile = await fetchMojangProfile(normalizedUsername, normalizedServerId)
        } catch (error) {
            set.status = 503
            return {
                success: false,
                error: 'Mojang session server unavailable'
            }
        }

        if (!mojangProfile) {
            return forbidden(set, 'Player has not joined')
        }

        if (mojangProfile.name.toLowerCase() !== normalizedUsername.toLowerCase()) {
            return forbidden(set, 'Username mismatch')
        }

        const nowSeconds = Math.floor(Date.now() / 1000)
        if (!process.env[JWT_SECRET_ENV]) {
            return serverError(set, 'JWT secret not configured')
        }

        const token = await gaiaJwt.sign({
            name: mojangProfile.name,
            uuid: mojangProfile.id,
            iat: nowSeconds,
            exp: nowSeconds + JWT_TTL_SECONDS
        })

        console.info('gaia auth confirmed handshake', {
            uuid: mojangProfile.id,
            name: mojangProfile.name,
            serverId: normalizedServerId
        })

        return {
            success: true,
            token,
            profile: {
                id: mojangProfile.id,
                name: mojangProfile.name
            },
            expiresInMs: JWT_TTL_MS
        }
    }, {
        body: 'confirmHandshakeBody',
        response: {
            200: 'confirmHandshakeSuccess',
            400: 'authError',
            403: 'authError',
            500: 'authError',
            503: 'authError'
        }
    })
