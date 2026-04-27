import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

const registry = new Registry()

collectDefaultMetrics({
    register: registry,
    prefix: 'gaia_'
})

const httpRequestTotal = new Counter({
    name: 'gaia_http_requests_total',
    help: 'total number of handled http requests',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry]
})

const httpRequestDurationSeconds = new Histogram({
    name: 'gaia_http_request_duration_seconds',
    help: 'http request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry]
})

const gatewayActiveConnections = new Gauge({
    name: 'gaia_gateway_active_connections',
    help: 'current number of active gateway websocket connections (counts sockets, not users)',
    registers: [registry]
})

const gatewayActiveUsers = new Gauge({
    name: 'gaia_gateway_active_users',
    help: 'current number of unique users with at least one active gateway websocket connection',
    registers: [registry]
})

const gatewayConnectionEvents = new Counter({
    name: 'gaia_gateway_connection_events_total',
    help: 'gateway websocket connection events',
    labelNames: ['event'] as const,
    registers: [registry]
})

const gatewayStaleConnectionsClosed = new Counter({
    name: 'gaia_gateway_stale_connections_closed_total',
    help: 'gateway websocket connections closed by the server-side liveness sweep',
    registers: [registry]
})

const uuidSegmentPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const integerSegmentPattern = /^\d+$/

/**
 * normalize pathnames into low-cardinality route labels.
 */
export const normalizeRouteLabel = (pathname: string) => {
    const normalizedPath = pathname.trim() || '/'
    const segments = normalizedPath.split('/').filter(Boolean)

    if (segments.length === 0) {
        return '/'
    }

    const normalizedSegments = segments.map((segment) => {
        if (uuidSegmentPattern.test(segment)) {
            return ':uuid'
        }

        if (integerSegmentPattern.test(segment)) {
            return ':id'
        }

        return segment
    })

    return `/${normalizedSegments.join('/')}`
}

/**
 * record one completed http request.
 */
export const recordHttpRequest = (method: string, pathname: string, status: number, durationMs: number) => {
    const route = normalizeRouteLabel(pathname)
    const methodLabel = method.toUpperCase()
    const statusLabel = status.toString()
    const durationSeconds = Math.max(durationMs / 1000, 0)

    httpRequestTotal.inc({
        method: methodLabel,
        route,
        status: statusLabel
    })

    httpRequestDurationSeconds.observe(
        {
            method: methodLabel,
            route,
            status: statusLabel
        },
        durationSeconds
    )
}

/**
 * update metrics when a gateway connection opens.
 */
export const recordGatewayConnectionOpened = (activeConnections: number, activeUsers?: number) => {
    gatewayConnectionEvents.inc({ event: 'open' })
    gatewayActiveConnections.set(activeConnections)
    if (typeof activeUsers === 'number') {
        gatewayActiveUsers.set(activeUsers)
    }
}

/**
 * update metrics when a gateway connection closes.
 */
export const recordGatewayConnectionClosed = (activeConnections: number, activeUsers?: number) => {
    gatewayConnectionEvents.inc({ event: 'close' })
    gatewayActiveConnections.set(activeConnections)
    if (typeof activeUsers === 'number') {
        gatewayActiveUsers.set(activeUsers)
    }
}

/**
 * count one connection forcibly closed by the server-side liveness sweep.
 */
export const recordGatewayStaleConnectionClosed = () => {
    gatewayStaleConnectionsClosed.inc()
}

/**
 * get prometheus metrics payload.
 */
export const getPrometheusMetrics = () => {
    return registry.metrics()
}

/**
 * get registry content type.
 */
export const getPrometheusContentType = () => {
    return registry.contentType
}

/**
 * reset metric values for tests.
 */
export const resetMetricsForTests = () => {
    registry.resetMetrics()
    gatewayActiveConnections.set(0)
    gatewayActiveUsers.set(0)
}
