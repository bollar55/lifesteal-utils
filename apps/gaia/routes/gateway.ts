import { Elysia } from 'elysia'
import {
    recordGatewayConnectionClosed,
    recordGatewayConnectionOpened,
    recordGatewayStaleConnectionClosed
} from '../services/metrics.ts'
import { type AuthenticatedUser, gaiaJwtPlugin, verifyGaiaToken } from './imperium/auth.ts'
import { extractBearerToken } from './utils/request.ts'

const CLOSE_POLICY_VIOLATION = 1008
const CLOSE_UNSUPPORTED_DATA = 1003
const CLOSE_IDLE_TIMEOUT = 1011
const SOCKET_OPEN_STATE = 1
const CLIENT_OP_PING = 'ping'
const CLIENT_OP_REFRESH = 'refresh'

// the deployed LSU client pings every 30s while connected. 3x that gives
// us one missed-ping tolerance for routine packet loss before evicting.
const STALE_AFTER_MS = 90_000
const SWEEP_INTERVAL_MS = 30_000

// matches Bun's documented websocket idleTimeout default (seconds). set
// explicitly so a future Bun default change can't silently extend the
// stale-connection window past the sweep's intent.
const WS_IDLE_TIMEOUT_SECONDS = 120

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
    lastSeenAt: number
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
    private sweepTimer: ReturnType<typeof setInterval> | null = null

    /**
     * begin the periodic liveness sweep. safe to call more than once;
     * subsequent calls are a no-op until stop() is called.
     */
    public start() {
        if (this.sweepTimer) {
            return
        }
        this.sweepTimer = setInterval(() => {
            this.sweepStaleConnections(Date.now(), STALE_AFTER_MS)
        }, SWEEP_INTERVAL_MS)
        // unref so the timer doesn't keep the process alive on its own
        this.sweepTimer.unref?.()
    }

    /**
     * stop the periodic liveness sweep.
     */
    public stop() {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer)
            this.sweepTimer = null
        }
    }

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

        // any valid client message proves the socket is live. the deployed
        // client pings every 30s, so this is the load-bearing signal for
        // the stale-connection sweep.
        connection.lastSeenAt = Date.now()

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
        this.stop()
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

    /**
     * iterate live sockets and close any whose last-seen timestamp is older
     * than the staleness threshold. exposed for tests; production callers
     * use start() which schedules this on a timer.
     */
    public sweepStaleConnections(now: number, staleAfterMs: number) {
        const cutoff = now - staleAfterMs
        const stale: GatewaySocket[] = []

        for (const [socketKey, ws] of this.socketByKey) {
            const connection = this.connectionState.get(socketKey)
            if (!connection) {
                continue
            }
            if (connection.lastSeenAt < cutoff) {
                stale.push(ws)
            }
        }

        for (const ws of stale) {
            recordGatewayStaleConnectionClosed()
            try {
                ws.close(CLOSE_IDLE_TIMEOUT, 'idle timeout')
            } catch {
                // best-effort. if close throws, fall back to manual untrack
                // so we don't leak the socket from our maps.
                this.untrackConnection(ws)
            }
        }
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
        this.connectionState.set(socketKey, { user, lastSeenAt: Date.now() })
        this.socketByKey.set(socketKey, ws)

        if (!alreadyTracked) {
            recordGatewayConnectionOpened(this.getActiveConnectionCount(), this.getActiveUserCount())
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
        recordGatewayConnectionClosed(this.getActiveConnectionCount(), this.getActiveUserCount())
    }

    private getActiveConnectionCount() {
        let activeConnectionCount = 0

        for (const connections of this.connectionsByUser.values()) {
            activeConnectionCount += connections.size
        }

        return activeConnectionCount
    }

    private getActiveUserCount() {
        return this.connectionsByUser.size
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
        idleTimeout: WS_IDLE_TIMEOUT_SECONDS,
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
