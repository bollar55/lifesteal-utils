import { Elysia } from 'elysia'
import { recordGatewayConnectionClosed, recordGatewayConnectionOpened } from '../services/metrics.ts'
import { type AuthenticatedUser, gaiaJwtPlugin, verifyGaiaToken } from './imperium/auth.ts'
import { extractBearerToken } from './utils/request.ts'

const CLOSE_POLICY_VIOLATION = 1008
const CLOSE_UNSUPPORTED_DATA = 1003
const SOCKET_OPEN_STATE = 1
const CLIENT_OP_PING = 'ping'
const CLIENT_OP_REFRESH = 'refresh'

type GatewayClientMessage = {
    op: typeof CLIENT_OP_PING | typeof CLIENT_OP_REFRESH
}

type GatewayServerMessage =
    | {
          op: 'ready'
          data: {
              user: AuthenticatedUser
              serverTimeMs: number
          }
      }
    | {
          op: 'event'
          type: string
          data: Record<string, unknown>
      }
    | {
          op: 'pong'
          data: {
              serverTimeMs: number
          }
      }
    | {
          op: 'error'
          error: {
              code: string
              message: string
          }
      }

type GatewaySocket = {
    data: { request: Request }
    raw?: object
    send: (data: unknown) => void
    close: (code?: number, reason?: string) => void
    readyState: number
}

type GatewayConnection = {
    user: AuthenticatedUser
}

const isGatewayClientMessage = (message: unknown): message is GatewayClientMessage => {
    if (!message || typeof message !== 'object') {
        return false
    }

    const op = (message as GatewayClientMessage).op
    return op === CLIENT_OP_PING || op === CLIENT_OP_REFRESH
}

/**
 * manages gateway websocket connections and event dispatch.
 */
export class GatewayHub {
    private readonly connectionsByUser = new Map<string, Set<object>>()
    private readonly connectionState = new WeakMap<object, GatewayConnection>()
    private readonly socketByKey = new Map<object, GatewaySocket>()

    /**
     * handle new websocket connections.
     */
    public async handleOpen(ws: GatewaySocket) {
        const request = ws.data.request
        const tokenFromHeader = extractBearerToken(request.headers.get('authorization'))
        const tokenFromQuery = new URL(request.url).searchParams.get('token')
        const token = tokenFromHeader ?? tokenFromQuery

        if (!token) {
            this.sendError(ws, 'unauthorized', 'missing token')
            ws.close(CLOSE_POLICY_VIOLATION, 'unauthorized')
            return
        }

        const user = await verifyGaiaToken(token)
        if (!user) {
            this.sendError(ws, 'unauthorized', 'invalid token')
            ws.close(CLOSE_POLICY_VIOLATION, 'unauthorized')
            return
        }

        this.trackConnection(user, ws)
        this.sendReady(ws, user)
    }

    /**
     * handle websocket close.
     */
    public handleClose(ws: GatewaySocket) {
        this.untrackConnection(ws)
    }

    /**
     * handle client messages.
     */
    public handleMessage(ws: GatewaySocket, message: unknown) {
        const socketKey = this.getSocketKey(ws)
        if (!isGatewayClientMessage(message)) {
            this.sendError(ws, 'invalid_message', 'unsupported message format')
            ws.close(CLOSE_UNSUPPORTED_DATA, 'unsupported message format')
            return
        }

        const connection = this.connectionState.get(socketKey)
        if (!connection) {
            this.sendError(ws, 'unauthorized', 'connection not initialized')
            ws.close(CLOSE_POLICY_VIOLATION, 'unauthorized')
            return
        }

        if (message.op === CLIENT_OP_PING) {
            ws.send({
                op: 'pong',
                data: {
                    serverTimeMs: Date.now()
                }
            } satisfies GatewayServerMessage)
            return
        }

        if (message.op === CLIENT_OP_REFRESH) {
            this.trackConnection(connection.user, ws)
            this.sendReady(ws, connection.user)
        }
    }

    /**
     * notify a specific user across all active connections.
     */
    public notifyUser(uuid: string, payload: { type: string; data: Record<string, unknown> }) {
        const message: GatewayServerMessage = {
            op: 'event',
            type: payload.type,
            data: payload.data
        }

        this.sendToUser(uuid, message)
    }

    /**
     * clear cached data for tests.
     */
    public resetForTests() {
        for (const ws of this.socketByKey.values()) {
            try {
                if (ws.readyState === 1) {
                    ws.close(1000, 'test cleanup')
                }
            } catch {
                // ignore close failures in test cleanup
            }
        }
        this.connectionsByUser.clear()
        this.socketByKey.clear()
    }

    private sendReady(ws: { send: (data: unknown) => void }, user: AuthenticatedUser) {
        ws.send({
            op: 'ready',
            data: {
                user,
                serverTimeMs: Date.now()
            }
        } satisfies GatewayServerMessage)
    }

    private sendError(ws: { send: (data: unknown) => void }, code: string, message: string) {
        ws.send({
            op: 'error',
            error: {
                code,
                message
            }
        } satisfies GatewayServerMessage)
    }

    private trackConnection(user: AuthenticatedUser, ws: GatewaySocket) {
        const socketKey = this.getSocketKey(ws)
        const alreadyTracked = this.connectionState.has(socketKey)
        const existing = this.connectionsByUser.get(user.uuid)
        const connections = existing ?? new Set<object>()
        connections.add(socketKey)
        this.connectionsByUser.set(user.uuid, connections)
        this.connectionState.set(socketKey, { user })
        this.socketByKey.set(socketKey, ws)

        if (!alreadyTracked) {
            recordGatewayConnectionOpened(this.getActiveConnectionCount())
        }
    }

    private untrackConnection(ws: GatewaySocket) {
        const socketKey = this.getSocketKey(ws)
        const connection = this.connectionState.get(socketKey)
        if (!connection) {
            return
        }

        const connections = this.connectionsByUser.get(connection.user.uuid)
        if (connections) {
            connections.delete(socketKey)
            if (connections.size === 0) {
                this.connectionsByUser.delete(connection.user.uuid)
            }
        }

        this.connectionState.delete(socketKey)
        this.socketByKey.delete(socketKey)
        recordGatewayConnectionClosed(this.getActiveConnectionCount())
    }

    private getActiveConnectionCount() {
        let activeConnectionCount = 0

        for (const connections of this.connectionsByUser.values()) {
            activeConnectionCount += connections.size
        }

        return activeConnectionCount
    }

    private sendToUser(uuid: string, message: GatewayServerMessage) {
        const connections = this.connectionsByUser.get(uuid)
        if (!connections) {
            return
        }

        for (const socketKey of connections) {
            const ws = this.socketByKey.get(socketKey)
            if (!ws) {
                continue
            }

            if (ws.readyState !== SOCKET_OPEN_STATE) {
                continue
            }

            ws.send(message)
        }
    }

    private getSocketKey(ws: GatewaySocket): object {
        return ws.raw ?? ws
    }
}

export const gatewayHub = new GatewayHub()

export const gatewayRouter = new Elysia({ prefix: '/v1/gateway' })
    .use(gaiaJwtPlugin)
    .ws('/connect', {
        open: async (ws) => {
            await gatewayHub.handleOpen(ws)
        },
        message: (ws, message) => {
            gatewayHub.handleMessage(ws, message)
        },
        close: (ws) => {
            gatewayHub.handleClose(ws)
        }
    })
