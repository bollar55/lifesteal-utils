import './setup.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals'
import { Elysia } from 'elysia'
import { collectivumRouter } from '../routes/collectivum/baltop.ts'
import { db } from '../services/db.ts'
import { createTestJwt } from './utils/jwt.ts'

const testUser = {
    uuid: '123e4567-e89b-12d3-a456-426614174000',
    name: 'BaltopSubmitter'
}

const uuidMap: Record<string, string> = {
    TestPlayer1: '11111111111111111111111111111111',
    TestPlayer2: '22222222222222222222222222222222'
}

const BEDROCK_TEST_NAME = '.BedrockPlayer'
const BEDROCK_TEST_ID = '0000000000000000000901f01a102a88'
const MISSING_BEDROCK_NAME = '.MissingBedrock'

const geyserUuidMap: Record<string, string> = {
    [BEDROCK_TEST_NAME]: BEDROCK_TEST_ID
}

const app = new Elysia().use(collectivumRouter)

let originalFetch: typeof fetch

const parseBody = async (body: BodyInit | null | undefined) => {
    if (!body) {
        return [] as string[]
    }
    if (typeof body === 'string') {
        return JSON.parse(body) as string[]
    }
    if (body instanceof ArrayBuffer) {
        return JSON.parse(new TextDecoder().decode(body)) as string[]
    }
    if (ArrayBuffer.isView(body)) {
        return JSON.parse(Buffer.from(body.buffer).toString()) as string[]
    }
    return [] as string[]
}

describe('Collectivum baltop API', () => {
    beforeAll(async () => {
        originalFetch = globalThis.fetch
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            const requestUrl =
                typeof _input === 'string'
                    ? _input
                    : _input instanceof URL
                      ? _input.toString()
                      : _input.url
            const url = new URL(requestUrl)
            if (url.hostname === 'api.geysermc.org') {
                const name = decodeURIComponent(url.pathname.split('/').pop() ?? '')
                const id = geyserUuidMap[name]
                if (!id) {
                    return new Response(null, { status: 404 })
                }

                return new Response(JSON.stringify({ id, name }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                })
            }

            const names = await parseBody(init?.body)
            const response = names
                .map((name) => ({ id: uuidMap[name], name }))
                .filter((entry) => entry.id)

            return new Response(JSON.stringify(response), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })
        }) as typeof fetch
    })

    beforeEach(async () => {
        await db.currencyRecord.deleteMany()
        await db.currencySubmission.deleteMany()
    })

    afterAll(async () => {
        globalThis.fetch = originalFetch
        await db.currencyRecord.deleteMany()
        await db.currencySubmission.deleteMany()
    })

    test('accepts a valid baltop submission', async () => {
        const token = createTestJwt(testUser.uuid, testUser.name)
        const payload = [
            { username: 'TestPlayer1', amount: 1200 },
            { username: 'TestPlayer2', amount: 3400 },
            { username: BEDROCK_TEST_NAME, amount: 800 }
        ]

        const response = await app.handle(
            new Request('http://localhost/v1/collectivum/baltop', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                    'User-Agent': 'LifestealUtils/9.9.9'
                },
                body: JSON.stringify(payload)
            })
        )

        expect(response.status).toBe(200)
        const data = (await response.json()) as { success: boolean; submissionId?: string }
        expect(data.success).toBe(true)
        expect(data.submissionId).toBeDefined()

        const submissions = await db.currencySubmission.findMany({
            include: { records: true }
        })
        expect(submissions.length).toBe(1)
        expect(submissions[0]!.submitterName).toBe(testUser.name)
        expect(submissions[0]!.modVersion).toBe('9.9.9')
        expect(submissions[0]!.records.length).toBe(3)
        expect(submissions[0]!.records[0]!.amount).toBe(1200n)
    })

    test('rejects non-integer amounts', async () => {
        const token = createTestJwt(testUser.uuid, testUser.name)
        const payload = [{ username: 'TestPlayer1', amount: 12.5 }]

        const response = await app.handle(
            new Request('http://localhost/v1/collectivum/baltop', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                    'User-Agent': 'LifestealUtils/9.9.9'
                },
                body: JSON.stringify(payload)
            })
        )

        expect(response.status).toBe(400)
        const submissions = await db.currencySubmission.findMany()
        expect(submissions.length).toBe(0)
    })

    test('skips unresolved entries and returns no content', async () => {
        const token = createTestJwt(testUser.uuid, testUser.name)
        const payload = [
            { username: 'TestPlayer1', amount: 1200 },
            { username: MISSING_BEDROCK_NAME, amount: 500 }
        ]

        const response = await app.handle(
            new Request('http://localhost/v1/collectivum/baltop', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                    'User-Agent': 'LifestealUtils/9.9.9'
                },
                body: JSON.stringify(payload)
            })
        )

        expect(response.status).toBe(204)

        const submissions = await db.currencySubmission.findMany({
            include: { records: true }
        })
        expect(submissions.length).toBe(1)
        expect(submissions[0]!.records.length).toBe(1)
        expect(submissions[0]!.records[0]!.amount).toBe(1200n)
    })
})
