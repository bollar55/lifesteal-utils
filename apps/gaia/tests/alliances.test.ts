import './setup.ts'
import { afterAll, beforeEach, describe, expect, test } from '@jest/globals'
import { Elysia } from 'elysia'
import { alliancesRouter } from '../routes/alliances.ts'
import { db } from '../services/db.ts'
import { createTestJwt } from './utils/jwt.ts'

const app = new Elysia().use(alliancesRouter)

const ownerUser = {
    uuid: '123e4567-e89b-12d3-a456-426614174002',
    name: 'AllianceOwner'
}

const buildAllianceData = (memberUuid: string) => ({
    name: 'Test Alliance',
    description: 'Integration test alliance',
    color: 0x33aaee,
    lists: [
        {
            id: 'main',
            name: 'Main',
            prefix: '[A]',
            members: [
                {
                    uuid: memberUuid,
                    addedAt: Date.now()
                }
            ]
        }
    ]
})

describe('Alliances API', () => {
    beforeEach(async () => {
        await db.allianceSubscription.deleteMany()
        await db.alliance.deleteMany()
    })

    afterAll(async () => {
        await db.allianceSubscription.deleteMany()
        await db.alliance.deleteMany()
    })

    test('requires authentication for listing subscriptions', async () => {
        const response = await app.handle(new Request('http://localhost/v1/alliances/subscriptions'))

        expect(response.status).toBe(401)
    })

    test('creates an alliance with valid payload', async () => {
        const token = createTestJwt(ownerUser.uuid, ownerUser.name)
        const response = await app.handle(
            new Request('http://localhost/v1/alliances', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({
                    subscriptionPermission: 'MEMBERS',
                    data: buildAllianceData(ownerUser.uuid)
                })
            })
        )

        expect(response.status).toBe(201)

        const payload = (await response.json()) as {
            success: boolean
            alliance: { id: string; owner: string; subscription_permission: string }
        }

        expect(payload.success).toBe(true)
        expect(payload.alliance.id).toHaveLength(3)
        expect(payload.alliance.owner).toBe(ownerUser.uuid)
        expect(payload.alliance.subscription_permission).toBe('MEMBERS')

        const subscriptions = await db.allianceSubscription.findMany({
            where: {
                userId: ownerUser.uuid
            }
        })
        expect(subscriptions.length).toBe(1)
    })

    test('validates alliance id parameter shape', async () => {
        const token = createTestJwt(ownerUser.uuid, ownerUser.name)
        const response = await app.handle(
            new Request('http://localhost/v1/alliances/TOOLONG', {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${token}`
                }
            })
        )

        expect(response.status).toBe(400)
        const payload = (await response.json()) as { success: boolean }
        expect(payload.success).toBe(false)
    })
})
