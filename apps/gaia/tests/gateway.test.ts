import './setup.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals'
import { gatewayHub } from '../routes/gateway.ts'
import { getPrometheusMetrics, resetMetricsForTests } from '../services/metrics.ts'
import { createTestJwt } from './utils/jwt.ts'
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
        resetMetricsForTests()
    })

    beforeEach(() => {
        gatewayHub.resetForTests()
        resetMetricsForTests()
    })

    afterAll(async () => {
        gatewayHub.resetForTests()
        resetMetricsForTests()
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

    test('connection count returns to zero after close', async () => {
        const token = createTestJwt(testUser1.uuid, testUser1.name)
        const ws = createMockSocket(
            new Request(`http://localhost/v1/gateway/connect?token=${encodeURIComponent(token)}`)
        )

        await gatewayHub.handleOpen(ws)

        let metrics = await getPrometheusMetrics()
        expect(metrics).toContain('gaia_gateway_active_connections 1')
        expect(metrics).toContain('gaia_gateway_active_users 1')

        ws.close(1000, 'normal closure')

        metrics = await getPrometheusMetrics()
        expect(metrics).toContain('gaia_gateway_active_connections 0')
        expect(metrics).toContain('gaia_gateway_active_users 0')
    })

    test('two opens for the same user count as 2 sockets and 1 user', async () => {
        const tokenA = createTestJwt(testUser1.uuid, testUser1.name)
        const tokenB = createTestJwt(testUser1.uuid, testUser1.name)
        const wsA = createMockSocket(
            new Request(`http://localhost/v1/gateway/connect?token=${encodeURIComponent(tokenA)}`)
        )
        const wsB = createMockSocket(
            new Request(`http://localhost/v1/gateway/connect?token=${encodeURIComponent(tokenB)}`)
        )

        await gatewayHub.handleOpen(wsA)
        await gatewayHub.handleOpen(wsB)

        let metrics = await getPrometheusMetrics()
        expect(metrics).toContain('gaia_gateway_active_connections 2')
        expect(metrics).toContain('gaia_gateway_active_users 1')

        wsA.close(1000, 'leaving')

        metrics = await getPrometheusMetrics()
        expect(metrics).toContain('gaia_gateway_active_connections 1')
        expect(metrics).toContain('gaia_gateway_active_users 1')

        wsB.close(1000, 'leaving')

        metrics = await getPrometheusMetrics()
        expect(metrics).toContain('gaia_gateway_active_connections 0')
        expect(metrics).toContain('gaia_gateway_active_users 0')
    })

    test('sweep closes sockets whose lastSeenAt is older than the staleness window', async () => {
        const token = createTestJwt(testUser1.uuid, testUser1.name)
        const ws = createMockSocket(
            new Request(`http://localhost/v1/gateway/connect?token=${encodeURIComponent(token)}`)
        )

        await gatewayHub.handleOpen(ws)

        let metrics = await getPrometheusMetrics()
        expect(metrics).toContain('gaia_gateway_active_connections 1')

        // simulate 91 seconds elapsed since the connection was last seen
        gatewayHub.sweepStaleConnections(Date.now() + 91_000, 90_000)

        expect(ws.closeCode).toBe(1011)
        expect(ws.closeReason).toBe('idle timeout')

        metrics = await getPrometheusMetrics()
        expect(metrics).toContain('gaia_gateway_active_connections 0')
        expect(metrics).toContain('gaia_gateway_active_users 0')
        expect(metrics).toContain('gaia_gateway_stale_connections_closed_total 1')
    })

    test('sweep leaves recently-pinged connections alone', async () => {
        const token = createTestJwt(testUser1.uuid, testUser1.name)
        const ws = createMockSocket(
            new Request(`http://localhost/v1/gateway/connect?token=${encodeURIComponent(token)}`)
        )

        await gatewayHub.handleOpen(ws)
        // a ping resets lastSeenAt
        await gatewayHub.handleMessage(ws, { op: 'ping' })

        // 60s after the ping is still inside the 90s window
        gatewayHub.sweepStaleConnections(Date.now() + 60_000, 90_000)

        expect(ws.closeCode).toBeUndefined()

        const metrics = await getPrometheusMetrics()
        expect(metrics).toContain('gaia_gateway_active_connections 1')
        expect(metrics).toContain('gaia_gateway_active_users 1')
    })
})
