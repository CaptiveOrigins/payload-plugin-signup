import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, handleEndpoints, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { RECEIVED, signupPlugin, submitSignup } from '../src/index.js'

// The built-in rate limiter, the form-posted confirm button, and the API refusing signed-out account creation.
// Made-up people at example.com, on a throwaway in-memory database.
let payload: Payload
let mongo: MongoMemoryReplSet
const mail: { to: string; text: string }[] = []
const from = (address: string) => ({ headers: new Headers({ 'x-forwarded-for': address }) }) as Partial<PayloadRequest>
const ask = (email: string, address: string) => submitSignup(payload, { email, details: { name: 'Made Up' } }, from(address))

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    key: 'builtin',
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      serverURL: 'https://site.example.com',
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('signup-builtin'), ensureIndexes: true }),
      email: (() => ({ name: 'test', defaultFromAddress: 'noreply@example.com', defaultFromName: 'Test', sendEmail: async (m: { to: string; text: string }) => void mail.push(m) })) as never,
      collections: [{ slug: 'users', auth: true, access: { create: () => true }, fields: [{ name: 'name', type: 'text' }] }],
      admin: { user: 'users' },
      plugins: [signupPlugin({ fields: [{ name: 'name', type: 'text' }], limits: { address: 2, email: 1 }, forceMode: 'approval', access: { manage: () => false } })],
    }),
  })
  const models = (payload.db as unknown as { collections: Record<string, { createCollection: () => Promise<unknown>; ensureIndexes: () => Promise<unknown> }> }).collections
  for (const m of Object.values(models)) await m.createCollection().catch(() => undefined)
  for (const m of Object.values(models)) await m.ensureIndexes()
  await payload.create({ collection: 'users', data: { email: 'first@example.com', password: 'first user password' } as never, overrideAccess: true })
}, 180_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

describe('the built-in rate limiter', () => {
  it('counts per address and per email, and stores only hashes', async () => {
    await expect(ask('a@example.com', '198.51.100.1')).resolves.toEqual({ ok: true, message: RECEIVED })
    // Second ask for the same email, from another address: over the email limit, so quietly nothing.
    const before = mail.length
    await expect(ask('a@example.com', '198.51.100.2')).resolves.toEqual({ ok: true, message: RECEIVED })
    expect(mail.length).toBe(before)
    await ask('b@example.com', '198.51.100.1')
    await expect(ask('c@example.com', '198.51.100.1')).rejects.toMatchObject({ code: 'busy', status: 429 })
    const stored = JSON.stringify((await payload.find({ collection: 'signup-attempts' as never, pagination: false, overrideAccess: true })).docs)
    expect(stored).not.toMatch(/198\.51\.100|example\.com/)
    expect(stored).toMatch(/[0-9a-f]{64}/)
  })

  it('gives each client address its own count through the real endpoint, so one person can’t use up everyone’s', async () => {
    // Before the fix, the endpoint's request reached the limiter without headers, so every visitor shared "unknown".
    const post = (email: string, address: string) =>
      handleEndpoints({
        config: payload.config,
        request: new Request('http://localhost/api/signup/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
          body: JSON.stringify({ email, details: { name: 'Made Up' } }),
        }),
      })
    expect((await post('f1@example.com', '198.51.100.41')).status).toBe(202)
    expect((await post('f2@example.com', '198.51.100.41')).status).toBe(202)
    expect((await post('f3@example.com', '198.51.100.41')).status).toBe(429)
    // Another client still gets in.
    expect((await post('f4@example.com', '198.51.100.42')).status).toBe(202)
  })
})

describe('the email link', () => {
  it('keeps the form, with a message, when the two passwords differ, and makes nothing', async () => {
    await ask('e@example.com', '198.51.100.10')
    const token = decodeURIComponent(/token=(\S+)/.exec(mail.filter((m) => m.to === 'e@example.com').at(-1)!.text)![1]!)
    const endpoint = payload.config.endpoints!.find((e) => e.path === '/signup/verify' && e.method === 'post')!
    const form = new Request('https://site.example.com/api/signup/verify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(token)}&password=first+long+password&confirm=other+long+password` })
    const html = await (await endpoint.handler(Object.assign(form, { payload }) as never)).text()
    expect(html).toContain('role="alert"')
    expect(html).toContain('<label for="password">')
    expect((await payload.find({ collection: 'users', where: { email: { equals: 'e@example.com' } }, overrideAccess: true })).totalDocs).toBe(0)
  })

  it('verifies when the confirm button posts the form', async () => {
    await ask('d@example.com', '198.51.100.9')
    const token = decodeURIComponent(/token=(\S+)/.exec(mail.filter((m) => m.to === 'd@example.com').at(-1)!.text)![1]!)
    const endpoint = payload.config.endpoints!.find((e) => e.path === '/signup/verify' && e.method === 'post')!
    const form = new Request('https://site.example.com/api/signup/verify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(token)}&password=correct+horse+battery&confirm=correct+horse+battery` })
    const res = await endpoint.handler(Object.assign(form, { payload }) as never)
    expect(await res.text()).toContain('A person will look at your request')
    const [user] = (await payload.find({ collection: 'users', where: { email: { equals: 'd@example.com' } }, overrideAccess: true })).docs as { signupStatus?: string }[]
    expect(user!.signupStatus).toBe('pending')
  })
})

describe('accounts only through sign-up', () => {
  it('refuses a signed-out API create once the site has users, even where the collection allows creating', async () => {
    await expect(payload.create({ collection: 'users', data: { email: 'sneaky@example.com', password: 'a long password' } as never, overrideAccess: false, req: { payloadAPI: 'REST' } as never })).rejects.toThrow()
  })
})
