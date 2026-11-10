import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { pruneSignupRequests, RECEIVED, signupPlugin, submitSignup, verifySignup, type CheckResult, type LimitKind } from '../src/index.js'

// Made-up people at example.com, on a throwaway in-memory database.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let payload: Payload
let mongo: MongoMemoryReplSet
const mail: { to: string; subject: string; text: string }[] = []
let checkResult: CheckResult | 'throw' = {}
let checkSaw: Doc[] = []
let approveThrows = false
let approved: string[] = []
let limiter: ((kind: LimitKind, key: string) => boolean) | null = null
let human: boolean | 'throw' = true
let admin: Doc

const req = (address = '203.0.113.7') => ({ headers: new Headers({ 'x-forwarded-for': `${address}, 10.0.0.1` }) }) as Partial<PayloadRequest>
const users = async (email: string) => (await payload.find({ collection: 'users', where: { email: { equals: email } }, overrideAccess: true })).docs as Doc[]
const requests = async (email: string) => (await payload.find({ collection: 'signup-requests' as never, where: { email: { equals: email } }, depth: 0, overrideAccess: true })).docs as Doc[]
const setMode = (mode: string) => payload.updateGlobal({ slug: 'signup-settings' as never, data: { mode } as never, overrideAccess: true })
const tokenFrom = (to: string) => {
  const m = [...mail].reverse().find((x) => x.to === to && x.subject.startsWith('Confirm'))
  return decodeURIComponent(/token=([^\s]+)/.exec(m?.text ?? '')?.[1] ?? '')
}
const staffUpdate = (id: unknown, data: Doc) => payload.update({ collection: 'signup-requests' as never, id: id as string, data: data as never, overrideAccess: false, user: { ...admin, collection: 'users' } as never })
const mailTo = (to: string) => mail.filter((m) => m.to === to).map((m) => m.subject)
const ask = (email: string, extra: Doc = {}, address?: string) =>
  submitSignup(payload, { email, password: 'correct horse battery', details: { name: 'Made Up', country: 'US' }, ...extra }, req(address))
const login = (email: string, password = 'correct horse battery') => payload.login({ collection: 'users', data: { email, password } })
let n = 0
const fresh = () => `person${++n}@example.com`

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      serverURL: 'https://site.example.com',
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('signup'), ensureIndexes: true }),
      email: (() => ({
        name: 'test',
        defaultFromAddress: 'noreply@example.com',
        defaultFromName: 'Test',
        sendEmail: async (m: { to: string; subject: string; text: string }) => void mail.push({ to: m.to, subject: m.subject, text: m.text }),
      })) as never,
      collections: [{ slug: 'users', auth: true, fields: [{ name: 'name', type: 'text' }, { name: 'country', type: 'text' }, { name: 'minorUntil', type: 'text' }] }],
      admin: { user: 'users' },
      plugins: [
        signupPlugin({
          fields: [
            { name: 'name', type: 'text', required: true },
            { name: 'country', type: 'text', required: true },
          ],
          toUser: (d) => ({ name: d.name, country: d.country }),
          checks: [
            ({ data, answers }) => {
              checkSaw.push({ data, answers })
              if (checkResult === 'throw') throw new Error('made-up check failure')
              return checkResult
            },
          ],
          onApprove: async ({ user }) => {
            if (approveThrows) throw new Error('made-up refusal')
            approved.push(String(user.email))
          },
          rateLimit: async (kind, key) => (limiter ? limiter(kind, key) : true),
          verifyHuman: async () => {
            if (human === 'throw') throw new Error('made-up outage')
            return human
          },
        }),
      ],
    }),
  })
  // A fresh database has no collections yet; make them (and their indexes) before any transaction, as a site's db:indexes does.
  const models = (payload.db as unknown as { collections: Record<string, { createCollection: () => Promise<unknown>; ensureIndexes: () => Promise<unknown> }> }).collections
  for (const m of Object.values(models)) await m.createCollection().catch(() => undefined)
  for (const m of Object.values(models)) await m.ensureIndexes()
  admin = (await payload.create({ collection: 'users', data: { email: 'staff@example.com', password: 'staff password long', name: 'Staff' } as never, overrideAccess: true })) as Doc
}, 180_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

beforeEach(async () => {
  checkResult = {}
  checkSaw = []
  approveThrows = false
  approved = []
  limiter = null
  human = true
  await setMode('approval')
})

describe('modes', () => {
  it('starts closed, refuses in closed and invite-only modes with the site’s message, and changes with the setting', async () => {
    await payload.updateGlobal({ slug: 'signup-settings' as never, data: { mode: 'closed', closedMessage: null, inviteOnlyMessage: 'Invitations only until Friday.' } as never, overrideAccess: true })
    await expect(ask(fresh())).rejects.toMatchObject({ code: 'closed', status: 403, message: 'Sign-up is closed for now.' })
    await setMode('invite-only')
    await expect(ask(fresh())).rejects.toMatchObject({ code: 'inviteOnly', message: 'Invitations only until Friday.' })
    await setMode('approval')
    await expect(ask(fresh())).resolves.toEqual({ ok: true, message: RECEIVED })
  })

  it('reports the mode to the form', async () => {
    const endpoint = payload.config.endpoints!.find((e) => e.path === '/signup/mode')!
    const res = await endpoint.handler({ payload } as never)
    expect(await res.json()).toEqual({ mode: 'approval', accepting: true, message: null })
  })
})

describe('approval mode, from request to sign-in', () => {
  it('verifies the email, waits as a disabled account, and activates on approval', async () => {
    const email = fresh()
    await ask(email, { details: { name: 'Made Up', country: 'US' }, answers: { birthYear: 1990 } })
    // An unverified account exists but can't sign in, and says why only to someone with the password.
    expect((await users(email))[0]).toMatchObject({ signupStatus: 'unverified', name: 'Made Up', country: 'US' })
    await expect(login(email, 'wrong password here')).rejects.toThrow(/incorrect/i)
    await expect(login(email)).rejects.toThrow(/confirm your address/)
    // Answers reach checks but are never stored.
    expect(checkSaw.at(-1)!.answers).toEqual({ birthYear: 1990 })
    expect(JSON.stringify(await requests(email))).not.toContain('1990')

    expect(await verifySignup(payload, tokenFrom(email), req())).toEqual({ status: 'pending' })
    expect(mailTo(email)).toEqual(['Confirm your email to finish signing up', 'Thanks, your request is in'])
    await expect(login(email)).rejects.toThrow(/waiting for approval/)

    const [request] = await requests(email)
    expect(request).toMatchObject({ status: 'pending', tokenHash: null })
    await staffUpdate(request!.id, { status: 'approved' })
    expect((await users(email))[0]!.signupStatus).toBe('active')
    expect(approved).toEqual([email])
    expect(mailTo(email).at(-1)).toBe('You\'re in')
    expect((await requests(email))[0]).toMatchObject({ status: 'approved', decidedBy: admin.id })
    await expect(login(email)).resolves.toMatchObject({ user: { email } })
  })

  it('declines: deletes the account, emails the note, and a repeat request changes nothing', async () => {
    const email = fresh()
    await ask(email)
    await verifySignup(payload, tokenFrom(email), req())
    const [request] = await requests(email)
    await staffUpdate(request!.id, { status: 'declined', note: 'We are only taking breeders this week.' })
    expect(await users(email)).toHaveLength(0)
    expect(mail.at(-1)).toMatchObject({ to: email, subject: 'About your account request' })
    expect(mail.at(-1)!.text).toContain('We are only taking breeders this week.')
    const before = mail.length
    await expect(ask(email)).resolves.toEqual({ ok: true, message: RECEIVED })
    expect([mail.length, (await users(email)).length, (await requests(email)).length]).toEqual([before, 0, 1])
  })

  it('rolls the approval back, with no email, when the site’s onApprove refuses', async () => {
    const email = fresh()
    await ask(email)
    await verifySignup(payload, tokenFrom(email), req())
    const [request] = await requests(email)
    approveThrows = true
    const before = mail.length
    await expect(staffUpdate(request!.id, { status: 'approved' })).rejects.toThrow()
    expect([(await users(email))[0]!.signupStatus, (await requests(email))[0]!.status, mail.length]).toEqual(['pending', 'pending', before])
  })
})

describe('open mode', () => {
  it('activates on verifying, with one "you’re in" email', async () => {
    await setMode('open')
    const email = fresh()
    await ask(email)
    expect(await verifySignup(payload, tokenFrom(email), req())).toEqual({ status: 'active' })
    expect((await users(email))[0]!.signupStatus).toBe('active')
    expect(mailTo(email)).toEqual(['Confirm your email to finish signing up', 'You\'re in'])
    expect((await requests(email))[0]).toMatchObject({ status: 'approved', decidedBy: null })
  })

  it('keeps a request waiting for staff if sign-up was shut between asking and verifying', async () => {
    await setMode('open')
    const email = fresh()
    await ask(email)
    await setMode('closed')
    expect(await verifySignup(payload, tokenFrom(email), req())).toEqual({ status: 'pending' })
  })
})

describe('no account enumeration', () => {
  it('answers the same for an existing account, and emails its owner instead of making anything', async () => {
    const email = fresh()
    await payload.create({ collection: 'users', data: { email, password: 'their own password', name: 'Existing' } as never, overrideAccess: true })
    await expect(ask(email)).resolves.toEqual({ ok: true, message: RECEIVED })
    expect(mailTo(email)).toEqual(['You already have an account'])
    expect([(await users(email)).length, (await requests(email)).length]).toEqual([1, 0])
    await expect(login(email, 'their own password')).resolves.toBeTruthy()
  })

  it('answers the same for an address already waiting, without another email', async () => {
    const email = fresh()
    await ask(email)
    await verifySignup(payload, tokenFrom(email), req())
    const before = mail.length
    await expect(ask(email)).resolves.toEqual({ ok: true, message: RECEIVED })
    expect(mail.length).toBe(before)
  })

  it('replaces an unverified request on a repeat (new details, new password, new link), so a stranger can’t hold an address', async () => {
    const email = fresh()
    await ask(email, { password: 'a strangers password' })
    const first = tokenFrom(email)
    await ask(email, { password: 'correct horse battery', details: { name: 'Real Owner', country: 'CA' } })
    const all = await requests(email)
    expect(all).toHaveLength(1)
    expect(all[0]!.details).toMatchObject({ name: 'Real Owner', country: 'CA' })
    await expect(verifySignup(payload, first, req())).rejects.toMatchObject({ code: 'badLink' })
    await verifySignup(payload, tokenFrom(email), req())
    await staffUpdate(all[0]!.id, { status: 'approved' })
    await expect(login(email, 'a strangers password')).rejects.toThrow()
    await expect(login(email)).resolves.toBeTruthy()
  })
})

describe('refusals, failing closed', () => {
  it('shows a site check’s refusal and stores nothing; a check that breaks refuses', async () => {
    const email = fresh()
    checkResult = { refuse: 'You need to be 13 or older to join.' }
    await expect(ask(email)).rejects.toMatchObject({ code: 'refused', message: 'You need to be 13 or older to join.' })
    checkResult = 'throw'
    await expect(ask(email)).rejects.toMatchObject({ code: 'checkFailed', status: 503 })
    expect([(await users(email)).length, (await requests(email)).length, mailTo(email).length]).toEqual([0, 0, 0])
  })

  it('carries a check’s flag to the queue and its user data to the account', async () => {
    const email = fresh()
    checkResult = { flag: 'minor', userData: { minorUntil: '2031-04' } }
    await ask(email)
    expect((await requests(email))[0]!.flag).toBe('minor')
    expect((await users(email))[0]!.minorUntil).toBe('2031-04')
  })

  it('refuses a bad email, a short password, missing required details, and a failed or broken human check', async () => {
    await expect(ask('not-an-email')).rejects.toMatchObject({ code: 'email' })
    await expect(ask(fresh(), { password: 'short' })).rejects.toMatchObject({ code: 'password' })
    await expect(ask(fresh(), { details: { country: 'US' } })).rejects.toThrow()
    human = false
    await expect(ask(fresh())).rejects.toMatchObject({ code: 'human' })
    human = 'throw'
    await expect(ask(fresh())).rejects.toMatchObject({ code: 'human' })
  })

  it('refuses expired, used and made-up links', async () => {
    const email = fresh()
    await ask(email)
    const token = tokenFrom(email)
    await expect(verifySignup(payload, 'x'.repeat(43), req())).rejects.toMatchObject({ code: 'badLink' })
    const [r] = await requests(email)
    await payload.update({ collection: 'signup-requests' as never, id: r!.id, data: { tokenExpires: new Date(Date.now() - 1000).toISOString() } as never, overrideAccess: true, context: { signupInternal: true } })
    await expect(verifySignup(payload, token, req())).rejects.toMatchObject({ code: 'badLink' })
  })

  it('opening the email’s link only shows a button: it never verifies by itself', async () => {
    const email = fresh()
    await ask(email)
    const endpoint = payload.config.endpoints!.find((e) => e.path === '/signup/verify' && e.method === 'get')!
    const res = await endpoint.handler({ payload, url: `https://site.example.com/api/signup/verify?token=${tokenFrom(email)}` } as never)
    expect(await res.text()).toContain('Confirm my email')
    expect((await requests(email))[0]!.status).toBe('unverified')
  })
})

describe('rate limits', () => {
  it('refuses past the address or site limit, goes quiet past the email limit, and refuses when the limiter breaks', async () => {
    limiter = (kind) => kind !== 'address'
    await expect(ask(fresh())).rejects.toMatchObject({ code: 'busy', status: 429 })
    limiter = (kind) => kind !== 'site'
    await expect(ask(fresh())).rejects.toMatchObject({ code: 'busy' })
    const email = fresh()
    limiter = (kind) => kind !== 'email'
    await expect(ask(email)).resolves.toEqual({ ok: true, message: RECEIVED })
    expect([(await users(email)).length, mailTo(email).length]).toEqual([0, 0])
    limiter = () => {
      throw new Error('made-up outage')
    }
    await expect(ask(fresh())).rejects.toMatchObject({ code: 'busy' })
  })
})

describe('staff and access', () => {
  it('lets staff decide only waiting requests, and change nothing but the decision and the note', async () => {
    const email = fresh()
    await ask(email)
    const [r] = await requests(email)
    await expect(staffUpdate(r!.id, { status: 'approved' })).rejects.toThrow(/isn.t verified/)
    await verifySignup(payload, tokenFrom(email), req())
    await staffUpdate(r!.id, { email: 'someone-else@example.com', details: { name: 'Changed', country: 'X' }, note: 'kept' })
    expect((await requests(email))[0]).toMatchObject({ email, status: 'pending', note: 'kept', details: { name: 'Made Up' } })
    await staffUpdate(r!.id, { status: 'declined' })
    await expect(staffUpdate(r!.id, { status: 'approved' })).rejects.toThrow(/already been decided/)
  })

  it('keeps the queue, the settings and the attempts away from anyone signed out, and stops anyone setting signupStatus', async () => {
    await expect(payload.find({ collection: 'signup-requests' as never, overrideAccess: false })).rejects.toThrow()
    await expect(payload.findGlobal({ slug: 'signup-settings' as never, overrideAccess: false })).rejects.toThrow()
    await expect(payload.find({ collection: 'signup-attempts' as never, overrideAccess: false, user: { ...admin, collection: 'users' } as never })).rejects.toThrow()
    await expect(payload.create({ collection: 'signup-requests' as never, data: { email: 'x@example.com' } as never, overrideAccess: false, user: { ...admin, collection: 'users' } as never })).rejects.toThrow()
    const made = (await payload.create({ collection: 'users', data: { email: fresh(), password: 'a long password', signupStatus: 'pending' } as never, overrideAccess: false, user: { ...admin, collection: 'users' } as never })) as Doc
    expect(made.signupStatus).toBe('active')
  })
})

describe('retention', () => {
  it('deletes decided and unverified requests (and unverified accounts) past the limit, and keeps waiting ones', async () => {
    const [a, b, c, d] = [fresh(), fresh(), fresh(), fresh()]
    for (const e of [a, b, c, d]) await ask(e)
    for (const e of [a, b, c]) await verifySignup(payload, tokenFrom(e), req())
    const decideAs = async (e: string, status: string) => staffUpdate((await requests(e))[0]!.id, { status })
    await decideAs(a, 'approved')
    await decideAs(b, 'declined')
    // c waits; d never verified.
    const inside = await pruneSignupRequests(payload, new Date(Date.now() + 89 * 86_400_000))
    expect(inside.requests).toBe(0)
    const later = await pruneSignupRequests(payload, new Date(Date.now() + 91 * 86_400_000))
    expect(later.requests).toBeGreaterThanOrEqual(3)
    expect([(await requests(a)).length, (await requests(b)).length, (await requests(c)).length, (await requests(d)).length]).toEqual([0, 0, 1, 0])
    expect([(await users(a)).length, (await users(d)).length]).toEqual([1, 0])
  })
})
