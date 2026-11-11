import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, handleEndpoints, type Payload, type PayloadRequest } from 'payload'
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
/** When set, what `access.manage` answers instead of the site's rule (staff by role). */
let manageAnswer: (() => unknown) | null = null
let admin: Doc
let member: Doc
const PW = 'correct horse battery'

const req = (address = '203.0.113.7') => ({ headers: new Headers({ 'x-forwarded-for': `${address}, 10.0.0.1` }) }) as Partial<PayloadRequest>
const as = (u: Doc) => ({ user: { ...u, collection: 'users' } as never })
const users = async (email: string) => (await payload.find({ collection: 'users', where: { email: { equals: email } }, depth: 0, overrideAccess: true })).docs as Doc[]
const requests = async (email: string) => (await payload.find({ collection: 'signup-requests' as never, where: { email: { equals: email } }, depth: 0, overrideAccess: true })).docs as Doc[]
const setMode = (mode: string) => payload.updateGlobal({ slug: 'signup-settings' as never, data: { mode } as never, overrideAccess: true })
const tokenFrom = (to: string) => {
  const m = [...mail].reverse().find((x) => x.to === to && x.subject.startsWith('Confirm'))
  return decodeURIComponent(/token=([^\s]+)/.exec(m?.text ?? '')?.[1] ?? '')
}
const staffUpdate = (id: unknown, data: Doc, by: Doc = admin) => payload.update({ collection: 'signup-requests' as never, id: id as string, data: data as never, overrideAccess: false, ...as(by) })
const mailTo = (to: string) => mail.filter((m) => m.to === to).map((m) => m.subject)
const ask = (email: string, extra: Doc = {}, address?: string) => submitSignup(payload, { email, details: { name: 'Made Up', country: 'US' }, ...extra }, req(address))
const confirm = (email: string, password = PW) => verifySignup(payload, { token: tokenFrom(email), password }, req())
const login = (email: string, password = PW) => payload.login({ collection: 'users', data: { email, password } })
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
      collections: [
        {
          slug: 'users',
          auth: true,
          access: { read: () => true },
          fields: [{ name: 'name', type: 'text' }, { name: 'country', type: 'text' }, { name: 'minorUntil', type: 'text' }, { name: 'role', type: 'text' }],
        },
      ],
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
          access: { manage: (({ req: r }: { req: PayloadRequest }) => (manageAnswer ? manageAnswer() : (r.user as { role?: string } | null)?.role === 'staff')) as never },
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
  admin = (await payload.create({ collection: 'users', data: { email: 'staff@example.com', password: 'staff password long', name: 'Staff', role: 'staff' } as never, overrideAccess: true })) as Doc
  member = (await payload.create({ collection: 'users', data: { email: 'member@example.com', password: 'member password long', name: 'Member', role: 'member' } as never, overrideAccess: true })) as Doc
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

describe('setup', () => {
  it('refuses to start without access.manage', () => {
    const plugin = signupPlugin({} as never)
    expect(() => plugin({ collections: [{ slug: 'users', auth: true, fields: [] }], admin: { user: 'users' } } as never)).toThrow(/access\.manage/)
  })
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
  it('makes no account until the address’s owner confirms and chooses a password; then it waits, and approval activates it', async () => {
    const email = fresh()
    await ask(email, { details: { name: 'Made Up', country: 'US' }, answers: { birthYear: 1990 } })
    expect(await users(email)).toHaveLength(0)
    // Answers reach checks but are never stored.
    expect(checkSaw.at(-1)!.answers).toEqual({ birthYear: 1990 })
    expect(JSON.stringify(await requests(email))).not.toContain('1990')

    await expect(confirm(email, 'short')).rejects.toMatchObject({ code: 'password' })
    expect(await confirm(email)).toEqual({ status: 'pending' })
    expect((await users(email))[0]).toMatchObject({ signupStatus: 'pending', name: 'Made Up', country: 'US' })
    expect(mailTo(email)).toEqual(['Confirm your email to finish signing up', 'Thanks, your request is in'])
    // "Waiting" is said only to someone with the right password.
    await expect(login(email, 'wrong password here')).rejects.toThrow(/incorrect/i)
    await expect(login(email)).rejects.toThrow(/waiting for approval/)

    const [request] = await requests(email)
    expect(request).toMatchObject({ status: 'pending', tokenHash: null })
    await staffUpdate(request!.id, { status: 'approved' })
    expect((await users(email))[0]!.signupStatus).toBe('active')
    expect(approved).toEqual([email])
    expect(mailTo(email).at(-1)).toBe('You\'re in')
    expect((await requests(email))[0]).toMatchObject({ status: 'approved', decidedBy: admin.id })
    await expect(login(email)).resolves.toMatchObject({ user: { email } })
    // The link works once.
    await expect(confirm(email)).rejects.toMatchObject({ code: 'badLink' })
  })

  it('declines: deletes the account, emails the note, and a repeat request changes nothing', async () => {
    const email = fresh()
    await ask(email)
    await confirm(email)
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
    await confirm(email)
    const [request] = await requests(email)
    approveThrows = true
    const before = mail.length
    await expect(staffUpdate(request!.id, { status: 'approved' })).rejects.toThrow()
    expect([(await users(email))[0]!.signupStatus, (await requests(email))[0]!.status, mail.length]).toEqual(['pending', 'pending', before])
  })
})

describe('open mode', () => {
  it('activates on confirming, with one "you’re in" email', async () => {
    await setMode('open')
    const email = fresh()
    await ask(email)
    expect(await confirm(email)).toEqual({ status: 'active' })
    expect((await users(email))[0]!.signupStatus).toBe('active')
    expect(mailTo(email)).toEqual(['Confirm your email to finish signing up', 'You\'re in'])
    expect((await requests(email))[0]).toMatchObject({ status: 'approved', decidedBy: null })
    await expect(login(email)).resolves.toBeTruthy()
  })

  it('keeps a request waiting for staff if sign-up was shut between asking and confirming', async () => {
    await setMode('open')
    const email = fresh()
    await ask(email)
    await setMode('closed')
    expect(await confirm(email)).toEqual({ status: 'pending' })
  })
})

describe('nobody can set up an account under someone else’s address', () => {
  it('asking with another person’s address gives the asker nothing: the owner chooses the password when confirming', async () => {
    await setMode('open')
    const owner = fresh()
    // Someone else asks with the owner's address. They never get to choose a password.
    await ask(owner, { details: { name: 'Not The Owner', country: 'US' } })
    expect(await users(owner)).toHaveLength(0)
    // The owner presses the button in the email they didn't ask for, choosing their own password.
    await confirm(owner, 'the owners own password')
    await expect(login(owner, 'the owners own password')).resolves.toBeTruthy()
    // Nothing the asker sent opens it.
    for (const guess of [PW, 'Not The Owner']) await expect(login(owner, guess)).rejects.toThrow()
  })

  it('a repeat before confirming only replaces the request and the link; the old link stops working', async () => {
    const email = fresh()
    await ask(email)
    const first = tokenFrom(email)
    await ask(email, { details: { name: 'Real Owner', country: 'CA' } })
    const all = await requests(email)
    expect(all).toHaveLength(1)
    expect(all[0]!.details).toMatchObject({ name: 'Real Owner', country: 'CA' })
    await expect(verifySignup(payload, { token: first, password: PW }, req())).rejects.toMatchObject({ code: 'badLink' })
    await expect(confirm(email)).resolves.toEqual({ status: 'pending' })
  })

  it('confirming an address that got an account meanwhile (an invitation) makes nothing new', async () => {
    const email = fresh()
    await ask(email)
    await payload.create({ collection: 'users', data: { email, password: 'invited account password' } as never, overrideAccess: true })
    await expect(confirm(email)).rejects.toMatchObject({ code: 'hasAccount' })
    expect(await users(email)).toHaveLength(1)
    await expect(login(email, 'invited account password')).resolves.toBeTruthy()
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
    await confirm(email)
    const before = mail.length
    await expect(ask(email)).resolves.toEqual({ ok: true, message: RECEIVED })
    expect(mail.length).toBe(before)
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

  it('carries a check’s flag to the queue and its user data to the account, without showing the data to staff', async () => {
    const email = fresh()
    checkResult = { flag: 'minor', userData: { minorUntil: '2031-04' } }
    await ask(email)
    const [r] = (await payload.find({ collection: 'signup-requests' as never, where: { email: { equals: email } }, depth: 0, overrideAccess: false, ...as(admin) })).docs as Doc[]
    expect([r!.flag, r!.userData]).toEqual(['minor', undefined])
    await confirm(email)
    expect((await users(email))[0]!.minorUntil).toBe('2031-04')
  })

  it('refuses a bad email, missing required details, and a failed or broken human check', async () => {
    await expect(ask('not-an-email')).rejects.toMatchObject({ code: 'email' })
    await expect(ask(fresh(), { details: { country: 'US' } })).rejects.toThrow()
    human = false
    await expect(ask(fresh())).rejects.toMatchObject({ code: 'human' })
    human = 'throw'
    await expect(ask(fresh())).rejects.toMatchObject({ code: 'human' })
  })

  it('refuses expired and made-up links', async () => {
    const email = fresh()
    await ask(email)
    const token = tokenFrom(email)
    await expect(verifySignup(payload, { token: 'x'.repeat(43), password: PW }, req())).rejects.toMatchObject({ code: 'badLink' })
    const [r] = await requests(email)
    await payload.update({ collection: 'signup-requests' as never, id: r!.id, data: { tokenExpires: new Date(Date.now() - 1000).toISOString() } as never, overrideAccess: true, context: { signupInternal: true } })
    await expect(verifySignup(payload, { token, password: PW }, req())).rejects.toMatchObject({ code: 'badLink' })
    expect(await users(email)).toHaveLength(0)
  })

  it('opening the email’s link only shows the password form: it never confirms by itself', async () => {
    const email = fresh()
    await ask(email)
    const endpoint = payload.config.endpoints!.find((e) => e.path === '/signup/verify' && e.method === 'get')!
    const html = await (await endpoint.handler({ payload, url: `https://site.example.com/api/signup/verify?token=${tokenFrom(email)}` } as never)).text()
    expect(html).toMatch(/<label for="password">/)
    expect(html).toContain('autocomplete="new-password"')
    expect([(await requests(email))[0]!.status, (await users(email)).length]).toEqual(['unverified', 0])
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
    expect([(await requests(email)).length, mailTo(email).length]).toEqual([0, 0])
    limiter = () => {
      throw new Error('made-up outage')
    }
    await expect(ask(fresh())).rejects.toMatchObject({ code: 'busy' })
  })

  it('counts a request with no known address under "unknown" instead of skipping the limit', async () => {
    const seen: string[] = []
    limiter = (kind, key) => {
      if (kind === 'address') seen.push(key)
      return true
    }
    await submitSignup(payload, { email: fresh(), details: { name: 'Made Up', country: 'US' } }, { headers: new Headers() } as Partial<PayloadRequest>)
    expect(seen).toEqual(['unknown'])
  })
})

describe('staff and access', () => {
  it('lets staff decide only waiting requests, and change nothing but the decision and the note', async () => {
    const email = fresh()
    await ask(email)
    const [r] = await requests(email)
    await expect(staffUpdate(r!.id, { status: 'approved' })).rejects.toThrow(/isn.t verified/)
    await confirm(email)
    await staffUpdate(r!.id, { email: 'someone-else@example.com', details: { name: 'Changed', country: 'X' }, note: 'kept' })
    expect((await requests(email))[0]).toMatchObject({ email, status: 'pending', note: 'kept', details: { name: 'Made Up' } })
    await staffUpdate(r!.id, { status: 'declined' })
    await expect(staffUpdate(r!.id, { status: 'approved' })).rejects.toThrow(/already been decided/)
  })

  it('keeps the queue and the settings from a signed-in member who isn’t staff, and from anyone signed out', async () => {
    const email = fresh()
    await ask(email)
    await confirm(email)
    const [r] = await requests(email)
    for (const who of [{}, as(member)]) {
      await expect(payload.find({ collection: 'signup-requests' as never, overrideAccess: false, ...who })).rejects.toThrow()
      await expect(payload.findGlobal({ slug: 'signup-settings' as never, overrideAccess: false, ...who })).rejects.toThrow()
      await expect(payload.updateGlobal({ slug: 'signup-settings' as never, data: { mode: 'open' } as never, overrideAccess: false, ...who })).rejects.toThrow()
    }
    await expect(staffUpdate(r!.id, { status: 'approved' }, member)).rejects.toThrow()
    expect((await requests(email))[0]!.status).toBe('pending')
    await expect(payload.find({ collection: 'signup-attempts' as never, overrideAccess: false, ...as(admin) })).rejects.toThrow()
    await expect(payload.create({ collection: 'signup-requests' as never, data: { email: 'x@example.com' } as never, overrideAccess: false, ...as(admin) })).rejects.toThrow()
  })

  it('shows signupStatus only to the account itself and to staff, and lets nobody set it', async () => {
    const email = fresh()
    await ask(email)
    await confirm(email)
    const [pending] = await users(email)
    const read = async (who: Doc) => ((await payload.findByID({ collection: 'users', id: pending!.id, overrideAccess: false, ...as(who) })) as Doc).signupStatus
    expect([await read(member), await read(admin), await read(pending!)]).toEqual([undefined, 'pending', 'pending'])
    const made = (await payload.create({ collection: 'users', data: { email: fresh(), password: 'a long password', signupStatus: 'pending' } as never, overrideAccess: false, ...as(admin) })) as Doc
    expect((await users(made.email))[0]!.signupStatus).toBe('active')
  })
})

describe('retention', () => {
  it('deletes decided and unconfirmed requests past the limit, and keeps waiting ones', async () => {
    const [a, b, c, d] = [fresh(), fresh(), fresh(), fresh()]
    for (const e of [a, b, c, d]) await ask(e)
    for (const e of [a, b, c]) await confirm(e)
    await staffUpdate((await requests(a))[0]!.id, { status: 'approved' })
    await staffUpdate((await requests(b))[0]!.id, { status: 'declined' })
    // c waits; d never confirmed.
    expect((await pruneSignupRequests(payload, new Date(Date.now() + 89 * 86_400_000))).requests).toBe(0)
    expect((await pruneSignupRequests(payload, new Date(Date.now() + 91 * 86_400_000))).requests).toBeGreaterThanOrEqual(3)
    expect([(await requests(a)).length, (await requests(b)).length, (await requests(c)).length, (await requests(d)).length]).toEqual([0, 0, 1, 0])
    expect([(await users(a)).length, (await users(c)).length]).toEqual([1, 1])
  })
})

describe('only an exact yes from access.manage (2026-11-11)', () => {
  // Each a no: truthy values, objects (one a query matching every request, which must not widen reads), and errors.
  const noes: [string, () => unknown][] = [
    ['1', () => 1],
    ["'yes'", () => 'yes'],
    ['{}', () => ({})],
    ['a query-shaped object', () => ({ email: { exists: true } })],
    ['a thrown error', () => {
      throw new Error('made-up directory outage')
    }],
    ['a rejected promise', async () => {
      throw new Error('made-up directory outage')
    }],
  ]
  const answering = async (answer: () => unknown, body: () => Promise<void>) => {
    manageAnswer = answer
    try {
      await body()
    } finally {
      manageAnswer = null
    }
  }
  let signedIn: Doc
  beforeEach(() => {
    signedIn = { overrideAccess: false, ...as(admin) }
  })

  it('keeps the queue, applicants\' emails, signupStatus and the settings from anything but true', async () => {
    const email = fresh()
    await ask(email)
    await confirm(email)
    const [r] = await requests(email)
    const [pending] = await users(email)
    const all = (await payload.count({ collection: 'signup-requests' as never, overrideAccess: true })).totalDocs
    expect(all).toBeGreaterThan(1)
    for (const [label, answer] of noes) {
      await answering(answer, async () => {
        await expect(payload.find({ collection: 'signup-requests' as never, pagination: false, ...signedIn }), label).rejects.toThrow()
        await expect(payload.findByID({ collection: 'signup-requests' as never, id: r!.id, ...signedIn }), label).rejects.toThrow()
        await expect(payload.update({ collection: 'signup-requests' as never, id: r!.id, data: { status: 'approved' } as never, ...signedIn }), label).rejects.toThrow()
        await expect(payload.delete({ collection: 'signup-requests' as never, id: r!.id, ...signedIn }), label).rejects.toThrow()
        await expect(payload.findGlobal({ slug: 'signup-settings' as never, ...signedIn }), label).rejects.toThrow()
        await expect(payload.updateGlobal({ slug: 'signup-settings' as never, data: { mode: 'open' } as never, ...signedIn }), label).rejects.toThrow()
        const seen = (await payload.findByID({ collection: 'users', id: pending!.id, ...signedIn })) as Doc
        expect(seen.signupStatus, label).toBeUndefined()
      })
    }
    expect((await requests(email))[0]).toMatchObject({ status: 'pending' })
    expect((await payload.count({ collection: 'signup-requests' as never, overrideAccess: true })).totalDocs).toBe(all)
    expect(((await payload.findGlobal({ slug: 'signup-settings' as never, overrideAccess: true })) as Doc).mode).toBe('approval')
    // Signed out is never a manager, even when access.manage says true.
    await answering(() => true, async () => {
      await expect(payload.find({ collection: 'signup-requests' as never, overrideAccess: false }), 'signed out').rejects.toThrow()
      await expect(payload.findGlobal({ slug: 'signup-settings' as never, overrideAccess: false }), 'signed out').rejects.toThrow()
    })
    // With exactly true, staff see every request and the settings, and decide.
    await answering(() => true, async () => {
      expect((await payload.find({ collection: 'signup-requests' as never, pagination: false, ...signedIn })).totalDocs).toBe(all)
      expect(((await payload.findGlobal({ slug: 'signup-settings' as never, ...signedIn })) as Doc).mode).toBe('approval')
      expect(((await payload.findByID({ collection: 'users', id: pending!.id, ...signedIn })) as Doc).signupStatus).toBe('pending')
      await payload.update({ collection: 'signup-requests' as never, id: r!.id, data: { status: 'declined' } as never, ...signedIn })
    })
    expect((await requests(email))[0]).toMatchObject({ status: 'declined' })
  })

  it('answers REST with 403, never a 500, when access.manage throws', async () => {
    const { token } = await login('staff@example.com', 'staff password long')
    const rest = (path: string) =>
      handleEndpoints({ config: payload.config, request: new Request(`http://localhost/api/${path}`, { headers: { Authorization: `JWT ${token}` } }) })
    await answering(() => {
      throw new Error('made-up directory outage')
    }, async () => {
      expect((await rest('signup-requests')).status).toBe(403)
      expect((await rest('globals/signup-settings')).status).toBe(403)
    })
    await answering(() => true, async () => {
      expect((await rest('signup-requests')).status).toBe(200)
    })
  })
})
