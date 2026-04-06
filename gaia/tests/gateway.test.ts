import './setup.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals'
import { createHmac } from 'crypto'
import { gatewayHub } from '../routes/gateway.ts'

const JWT_ISSUER = 'gaia.candycup.dev'
const JWT_TTL_SECONDS = 60 * 60
const CLOSE_POLICY_VIOLATION = 1008
const CLOSE_UNSUPPORTED_DATA = 1003
const SOCKET_OPEN_STATE = 1
const SOCKET_CLOSED_STATE = 3

type GatewayMessage = Record<string, unknown>

type MockSocket = {
    data: { request: Request }
    sentMessages: GatewayMessage[]
    readyState: number
    closeCode?: number
    closeReason?: string
    send: (data: unknown) => void
    close: (code?: number, reason?: string) => void
}

const base64UrlEncode = (value: string) => {
    return Buffer.from(value)
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
}

const createTestJwt = (uuid: string, name: string) => {
    const secret = process.env.GAIA_JWT_SECRET
    if (!secret) {
        throw new Error('GAIA_JWT_SECRET not set')
    }

    const nowSeconds = Math.floor(Date.now() / 1000)
    const header = { alg: 'HS256', typ: 'JWT' }
    const payload = {
        iss: JWT_ISSUER,
        iat: nowSeconds,
        exp: nowSeconds + JWT_TTL_SECONDS,
        uuid,
        name
    }

    const encodedHeader = base64UrlEncode(JSON.stringify(header))
    const encodedPayload = base64UrlEncode(JSON.stringify(payload))
    const data = `${encodedHeader}.${encodedPayload}`
    const signature = createHmac('sha256', secret).update(data).digest('base64')
    const encodedSignature = signature.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

    return `${data}.${encodedSignature}`
}

const createMockSocket = (request: Request): MockSocket => {
    const socket: MockSocket = {
        data: { request },
        sentMessages: [],
        readyState: SOCKET_OPEN_STATE,
        send: (data) => {
            socket.sentMessages.push(data as GatewayMessage)
        },
        close: (code, reason) => {
            socket.closeCode = code
            socket.closeReason = reason
            socket.readyState = SOCKET_CLOSED_STATE
            gatewayHub.handleClose(socket)
        }
    }

    return socket
}

const testUser1 = {
    uuid: '123e4567-e89b-12d3-a456-426614174000',
    name: 'GatewayUser1'
}

const testUser2 = {
    uuid: '223e4567-e89b-12d3-a456-426614174000',
    name: 'GatewayUser2'
}

describe('Gateway websocket', () => {
    beforeAll(async () => {
        gatewayHub.resetForTests()
    })

    beforeEach(() => {
        gatewayHub.resetForTests()
    })

    afterAll(async () => {
        gatewayHub.resetForTests()
    })

    test('rejects websocket connections without token', async () => {
        const ws = createMockSocket(new Request('http://localhost/v1/gateway/connect'))

        await gatewayHub.handleOpen(ws)

        expect(ws.closeCode).toBe(CLOSE_POLICY_VIOLATION)
        expect(ws.sentMessages.length).toBe(1)
        expect(ws.sentMessages[0]).toMatchObject({
            op: 'error',
            error: { code: 'unauthorized' }
        })
    })

    test('sends ready message for valid token', async () => {
        const token = createTestJwt(testUser1.uuid, testUser1.name)
        const ws = createMockSocket(
            new Request(`http://localhost/v1/gateway/connect?token=${encodeURIComponent(token)}`)
        )

        await gatewayHub.handleOpen(ws)

        expect(ws.sentMessages.length).toBe(1)
        expect(ws.sentMessages[0]).toMatchObject({
            op: 'ready',
            data: {
                user: { uuid: testUser1.uuid }
            }
        })
    })

    test('notifies a specific user across active connections', async () => {
        const token1 = createTestJwt(testUser1.uuid, testUser1.name)
        const token2 = createTestJwt(testUser2.uuid, testUser2.name)
        const ws1 = createMockSocket(
            new Request(`http://localhost/v1/gateway/connect?token=${encodeURIComponent(token1)}`)
        )
        const ws2 = createMockSocket(
            new Request(`http://localhost/v1/gateway/connect?token=${encodeURIComponent(token2)}`)
        )

        await gatewayHub.handleOpen(ws1)
        await gatewayHub.handleOpen(ws2)

        ws1.sentMessages = []
        ws2.sentMessages = []

        await gatewayHub.notifyUser(testUser1.uuid, {
            type: 'user.notification',
            data: { message: 'hello' }
        })

        expect(ws1.sentMessages.length).toBe(1)
        expect(ws1.sentMessages[0]).toMatchObject({
            op: 'event',
            type: 'user.notification'
        })
        expect(ws2.sentMessages.length).toBe(0)
    })

    test('refresh sends updated ready payload', async () => {
        const token2 = createTestJwt(testUser2.uuid, testUser2.name)
        const ws2 = createMockSocket(
            new Request(`http://localhost/v1/gateway/connect?token=${encodeURIComponent(token2)}`)
        )

        await gatewayHub.handleOpen(ws2)
        ws2.sentMessages = []

        await gatewayHub.handleMessage(ws2, { op: 'refresh' })

        expect(ws2.sentMessages.length).toBe(1)
        expect(ws2.sentMessages[0]).toMatchObject({
            op: 'ready',
            data: {
                user: { uuid: testUser2.uuid }
            }
        })
    })

    test('responds to ping messages', async () => {
        const token = createTestJwt(testUser1.uuid, testUser1.name)
        const ws = createMockSocket(
            new Request(`http://localhost/v1/gateway/connect?token=${encodeURIComponent(token)}`)
        )

        await gatewayHub.handleOpen(ws)
        ws.sentMessages = []

        await gatewayHub.handleMessage(ws, { op: 'ping' })

        expect(ws.sentMessages.length).toBe(1)
        expect(ws.sentMessages[0]).toMatchObject({
            op: 'pong'
        })
    })

    test('rejects unsupported message format', async () => {
        const token = createTestJwt(testUser1.uuid, testUser1.name)
        const ws = createMockSocket(
            new Request(`http://localhost/v1/gateway/connect?token=${encodeURIComponent(token)}`)
        )

        await gatewayHub.handleOpen(ws)
        ws.sentMessages = []

        await gatewayHub.handleMessage(ws, { op: 'unsupported' })

        expect(ws.sentMessages[0]).toMatchObject({
            op: 'error',
            error: { code: 'invalid_message' }
        })
        expect(ws.closeCode).toBe(CLOSE_UNSUPPORTED_DATA)
    })
})
