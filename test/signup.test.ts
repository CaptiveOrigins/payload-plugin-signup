import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { pruneSignupRequests, readSignupRequest, RECEIVED, signupPlugin, submitSignup, verifySignup, type CheckResult, type LimitKind } from '../src/index.js'

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

let confirmResult: CheckResult | 'throw' | undefined
const confirmSaw: Doc[] = []

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
            { name: 'pet', type: 'text', label: '<i>Pet</i>' },
            { name: 'school', type: 'text' },
            { name: 'staffNote', type: 'text', admin: { hidden: true } },
            { name: 'birthDate', type: 'text', access: { read: () => false } },
          ],
          // Listed: name, country and pet. school isn't listed; staffNote and birthDate are listed but must never show.
          confirmShows: ['name', 'country', 'pet', 'staffNote', 'birthDate'],
          toUser: (d) => ({ name: d.name, country: d.country }),
          checks: [
            ({ data, answers }) => {
              checkSaw.push({ data, answers })
              if (checkResult === 'throw') throw new Error('made-up check failure')
              return checkResult
            },
          ],
          confirmChecks: [
            (args) => {
              confirmSaw.push(args)
              if (confirmResult === 'throw') throw new Error('made-up confirm check failure')
              return confirmResult
            },
          ],
          onApprove: async ({ user }) => {
            if (approveThrows) throw new Error('made-up refusal')
            approved.push(String(user.email))
          },
          access: { manage: ({ req: r }) => (r.user as { role?: string } | null)?.role === 'staff' },
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

describe('the confirm page shows what was asked for', () => {
  const getPage = async (token: string) => {
    const endpoint = payload.config.endpoints!.find((e) => e.path === '/signup/verify' && e.method === 'get')!
    const res = await endpoint.handler({ payload, headers: new Headers({ 'x-forwarded-for': '203.0.113.7' }), url: `https://site.example.com/api/signup/verify?token=${encodeURIComponent(token)}` } as never)
    return { status: res.status, html: await res.text() }
  }

  it('reads the email and the details by token, without using up the link or showing what checks set', async () => {
    const email = fresh()
    checkResult = { userData: { minorUntil: '2031-01' } }
    await submitSignup(payload, { email, details: { name: 'Made Up', country: 'US' }, answers: { birthYear: 2015 } }, req())
    const token = tokenFrom(email)
    const shown = await readSignupRequest(payload, { token }, req())
    expect(shown).toEqual({ email, details: [{ name: 'name', label: 'Name', value: 'Made Up' }, { name: 'country', label: 'Country', value: 'US' }] })
    expect(JSON.stringify(shown)).not.toMatch(/2031|2015/)
    // Reading twice changes nothing; the link still confirms.
    await readSignupRequest(payload, { token }, req())
    expect([(await requests(email))[0]!.status, (await users(email)).length]).toEqual(['unverified', 0])
    expect(await verifySignup(payload, { token, password: PW }, req())).toEqual({ status: 'pending' })
    // Once used, the link reads as dead, the same as a made-up one.
    await expect(readSignupRequest(payload, { token }, req())).rejects.toMatchObject({ code: 'badLink' })
    await expect(readSignupRequest(payload, { token: 'x'.repeat(43) }, req())).rejects.toMatchObject({ code: 'badLink' })
    await expect(readSignupRequest(payload, { token: 5 }, req())).rejects.toMatchObject({ code: 'badLink' })
  })

  it('refuses an expired link, and counts reads against the verify limit', async () => {
    const email = fresh()
    await ask(email)
    const token = tokenFrom(email)
    limiter = (kind) => kind !== 'verify'
    await expect(readSignupRequest(payload, { token }, req())).rejects.toMatchObject({ code: 'busy' })
    limiter = null
    const [r] = await requests(email)
    await payload.update({ collection: 'signup-requests' as never, id: r!.id, data: { tokenExpires: new Date(Date.now() - 1000).toISOString() } as never, overrideAccess: true, context: { signupInternal: true } })
    await expect(readSignupRequest(payload, { token }, req())).rejects.toMatchObject({ code: 'badLink' })
  })

  it('shows only the fields the site listed, never hidden or read-restricted ones, even when listed', async () => {
    const email = fresh()
    await submitSignup(payload, { email, details: { name: 'Made Up', country: 'US', pet: 'Gecko', school: 'Made-up School', staffNote: 'internal', birthDate: '2015-04-01' } }, req())
    const shown = await readSignupRequest(payload, { token: tokenFrom(email) }, req())
    expect(shown.details.map((d) => d.name)).toEqual(['name', 'country', 'pet'])
    expect(JSON.stringify(shown)).not.toMatch(/Made-up School|internal|2015/)
  })

  it('keeps the summary on a password retry, and a mismatch still counts against the verify limit', async () => {
    const email = fresh()
    await ask(email)
    const token = tokenFrom(email)
    const endpoint = payload.config.endpoints!.find((e) => e.path === '/signup/verify' && e.method === 'post')!
    const post = async (password: string, confirm: string) => {
      const body = new URLSearchParams({ token, password, confirm })
      const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.7' })
      const res = await endpoint.handler({ payload, headers, formData: async () => new Request('http://x', { method: 'POST', body, headers }).formData() } as never)
      return { status: res.status, html: await res.text() }
    }
    const short = await post('short', 'short')
    expect(short.status).toBe(400)
    expect(short.html).toMatch(/at least 10 characters/)
    expect(short.html).toContain(`You asked for an account as <strong>${email}</strong>`)
    const kinds: string[] = []
    limiter = (kind) => (kinds.push(kind), true)
    const mismatch = await post(PW, PW + 'x')
    expect(mismatch.html).toMatch(/Please type the same password twice/)
    expect(mismatch.html).toContain('<dl>')
    expect(kinds).toEqual(['verify'])
    expect([(await requests(email))[0]!.status, (await users(email)).length]).toEqual(['unverified', 0])
  })

  it('shows the request above the password form, escaped, and says at once when a link is dead', async () => {
    const email = fresh()
    await submitSignup(payload, { email, details: { name: '<b>Made</b> & Up', country: 'US', pet: 'Gecko' } }, req())
    const token = tokenFrom(email)
    // Payload's email field refuses this address, but the page mustn't rely on that: write it straight to the database.
    const [r] = await requests(email)
    await payload.db.updateOne({ collection: 'signup-requests', where: { id: { equals: r!.id } }, data: { email: '<img/src=x/onerror=alert(1)>@a.bc' } } as never)
    const ok = await getPage(token)
    expect(ok.status).toBe(200)
    expect(ok.html).toContain('You asked for an account as <strong>&lt;img/src=x/onerror=alert(1)&gt;@a.bc</strong>')
    expect(ok.html).toContain('<dt>Name</dt><dd>&lt;b&gt;Made&lt;/b&gt; &amp; Up</dd>')
    expect(ok.html).toContain('<dt>&lt;i&gt;Pet&lt;/i&gt;</dt>')
    expect(ok.html).not.toMatch(/<b>Made<\/b>|<img|<i>Pet/)
    expect(ok.html.indexOf('<dl>')).toBeLessThan(ok.html.indexOf('<form'))
    const dead = await getPage('x'.repeat(43))
    expect(dead.status).toBe(400)
    expect(dead.html).toMatch(/expired or was already used/)
    expect(dead.html).not.toContain('<form')
    // A limiter that refuses still leaves the form, without the summary, so the link can be used later.
    limiter = (kind) => kind !== 'verify'
    const busy = await getPage(token)
    expect(busy.html).toContain('<form')
    expect(busy.html).not.toContain('<dl>')
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

describe('checks again at confirm', () => {
  it('declines at confirm when a check now refuses: no account, a dead link, and asking again changes nothing', async () => {
    const email = fresh()
    await ask(email)
    const token = tokenFrom(email)
    confirmResult = { refuse: 'This address can’t join right now.' }
    await expect(verifySignup(payload, { token, password: PW }, req())).rejects.toMatchObject({ code: 'refused', message: 'This address can’t join right now.' })
    confirmResult = undefined
    expect((await users(email)).length).toBe(0)
    expect((await requests(email))[0]).toMatchObject({ status: 'declined' })
    // The link's hash is gone from the stored row, not only refused by status.
    expect(await (payload.db as any).collections['signup-requests'].findOne({ email }).lean()).toMatchObject({ tokenHash: null, tokenExpires: null }) // eslint-disable-line @typescript-eslint/no-explicit-any
    await expect(verifySignup(payload, { token, password: PW }, req())).rejects.toMatchObject({ code: 'badLink' })
    const before = mail.length
    await expect(ask(email)).resolves.toEqual({ ok: true, message: RECEIVED })
    expect(mail.length).toBe(before)
  })

  it('refuses for now when a confirm check breaks, keeping the request and the same link for later', async () => {
    const email = fresh()
    await ask(email)
    const token = tokenFrom(email)
    confirmResult = 'throw'
    await expect(verifySignup(payload, { token, password: PW }, req())).rejects.toMatchObject({ code: 'checkFailed', status: 503 })
    confirmResult = undefined
    expect([(await users(email)).length, (await requests(email))[0]!.status]).toEqual([0, 'unverified'])
    await expect(verifySignup(payload, { token, password: PW }, req())).resolves.toMatchObject({ status: expect.any(String) })
    expect((await users(email)).length).toBe(1)
  })

  it('sees the stored details and flag but never the check-only answers, and adds its own flag and user data', async () => {
    const email = fresh()
    checkResult = { flag: 'minor' }
    await ask(email, { answers: { birthMonth: '2015-04' } })
    checkResult = {}
    confirmSaw.length = 0
    confirmResult = { flag: 'domain watched', userData: { role: 'member' } }
    await confirm(email)
    confirmResult = undefined
    expect(confirmSaw).toHaveLength(1)
    expect(confirmSaw[0]).toMatchObject({ email, flag: 'minor', data: { name: 'Made Up', country: 'US' } })
    expect(JSON.stringify(confirmSaw[0]!.data)).not.toContain('2015-04')
    expect('answers' in confirmSaw[0]!).toBe(false)
    expect((await requests(email))[0]).toMatchObject({ flag: 'minor; domain watched' })
    expect((await users(email))[0]).toMatchObject({ role: 'member' })
  })
})
