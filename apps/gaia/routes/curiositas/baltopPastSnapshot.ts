import { Elysia, t } from 'elysia'
import { db } from '../../services/db.ts'
import { badRequest } from '../utils/http.ts'
import { requireAuth } from '../imperium/auth.ts'

const RANGE_24_HOURS = '24h'
const RANGE_7_DAYS = '7d'
const SUPPORTED_RANGES = [RANGE_24_HOURS, RANGE_7_DAYS] as const
const TOP_PLAYER_LIMIT = 90
const HOUR_IN_MS = 60 * 60 * 1000
const DAY_IN_MS = 24 * HOUR_IN_MS

type SupportedRange = (typeof SUPPORTED_RANGES)[number]

type SnapshotRow = {
    uuid: string
    username: string
    currentAmount: bigint
    pastAmount: bigint | null
}

const snapshotQuerySchema = t.Object({
    range: t.Union([t.Literal(RANGE_24_HOURS), t.Literal(RANGE_7_DAYS)])
})

const snapshotEntrySchema = t.Object({
    uuid: t.String(),
    username: t.String(),
    currentAmount: t.String(),
    pastAmount: t.Union([t.String(), t.Null()])
})

const snapshotSuccessSchema = t.Object({
    success: t.Literal(true),
    range: t.String(),
    snapshotAt: t.String(),
    entries: t.Array(snapshotEntrySchema)
})

const snapshotErrorSchema = t.Object({
    success: t.Literal(false),
    error: t.String()
})

export const curiositasBaltopSnapshotRouter = new Elysia({ prefix: '/v1/curiositas' })
    .use(requireAuth)
    .model({
        curiositasSnapshotQuery: snapshotQuerySchema,
        curiositasSnapshotSuccess: snapshotSuccessSchema,
        curiositasSnapshotError: snapshotErrorSchema
    })
    .onError(({ code, set }) => {
        if (code === 'VALIDATION') {
            return badRequest(set, `Invalid range. Supported values: ${SUPPORTED_RANGES.join(', ')}`)
        }
    })
    .get('/baltop-past-snapshot', async ({ query }) => {
        const range = query.range as SupportedRange

        const rangeMs = (range === RANGE_24_HOURS) ? DAY_IN_MS : 7 * DAY_IN_MS
        const snapshotAt = new Date(Date.now() - rangeMs)
        const rows = await db.$queryRaw<SnapshotRow[]>`
            WITH current_latest AS (
                SELECT DISTINCT ON (cr.uuid)
                    cr.uuid,
                    cr.username,
                    cr.amount AS current_amount
                FROM currency_records cr
                INNER JOIN currency_submissions cs ON cs.id = cr."submissionId"
                WHERE cr."currencyType" = 'COINS'
                ORDER BY cr.uuid, cs."submittedAt" DESC, cr.id DESC
            ),
            top_current AS (
                SELECT
                    uuid,
                    username,
                    current_amount
                FROM current_latest
                ORDER BY current_amount DESC, username ASC
                LIMIT ${TOP_PLAYER_LIMIT}
            ),
            past_latest AS (
                SELECT DISTINCT ON (cr.uuid)
                    cr.uuid,
                    cr.amount AS past_amount
                FROM currency_records cr
                INNER JOIN currency_submissions cs ON cs.id = cr."submissionId"
                WHERE cr."currencyType" = 'COINS'
                    AND cr.uuid IN (SELECT uuid FROM top_current)
                    AND cs."submittedAt" <= ${snapshotAt}
                ORDER BY cr.uuid, cs."submittedAt" DESC, cr.id DESC
            )
            SELECT
                tc.uuid,
                tc.username,
                tc.current_amount AS "currentAmount",
                pl.past_amount AS "pastAmount"
            FROM top_current tc
            LEFT JOIN past_latest pl ON pl.uuid = tc.uuid
            ORDER BY tc.current_amount DESC, tc.username ASC
        `

        return {
            success: true,
            range,
            snapshotAt: snapshotAt.toISOString(),
            entries: rows.map((row) => ({
                uuid: row.uuid,
                username: row.username,
                currentAmount: row.currentAmount.toString(),
                pastAmount: row.pastAmount === null ? null : row.pastAmount.toString()
            }))
        }
    }, {
        query: 'curiositasSnapshotQuery',
        response: {
            200: 'curiositasSnapshotSuccess',
            400: 'curiositasSnapshotError',
            401: 'curiositasSnapshotError'
        }
    })
