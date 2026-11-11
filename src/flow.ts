import type { CollectionSlug, Payload, Where } from 'payload'

import type { ID, LimitKind, Req, SignupMode } from './types.js'
import { MODES } from './types.js'
import { asReq, cookiesOf, hashKey, hashToken, idOf, newToken, normalizeEmail, requestFor, signupOf, SignupError, transaction, validEmail } from './util.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const sys = { overrideAccess: true, depth: 0 } as const
const internal = { signupInternal: true }
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** What the form says for every request it takes, whatever happened, so it never tells who has an account. */
export const RECEIVED = 'Thanks. Check your email to continue.'

// ---------------------------------------------------------------------------------------------
// Mode

/**
 * The mode now. The site's lock (`forceMode`, or `SIGNUP_MODE`) wins, then the admin setting. Anything that
 * can't be read or isn't a known mode is `closed`: sign-up fails shut.
 */
export async function currentMode(payload: Payload): Promise<{ mode: SignupMode; message: string | null }> {
  const o = signupOf(payload)
  try {
    const settings = (await payload.findGlobal({ slug: o.settings as never, ...sys })) as Doc
    const mode = (o.forceMode ?? settings?.mode) as SignupMode
    if (!MODES.includes(mode)) return { mode: 'closed', message: null }
    const message =
      mode === 'invite-only' ? settings?.inviteOnlyMessage || 'Sign-up is by invitation for now.' : mode === 'closed' ? settings?.closedMessage || 'Sign-up is closed for now.' : null
    return { mode, message }
  } catch (error) {
    payload.logger.error({ err: error, msg: 'signup: settings not readable, so sign-up is closed' })
    return { mode: 'closed', message: 'Sign-up is closed for now.' }
  }
}

// ---------------------------------------------------------------------------------------------
// Rate limits

/** True to allow. The site's limiter if it gave one, else the built-in one. Any error refuses. */
async function allowed(payload: Payload, kind: LimitKind, key: string, req: Req): Promise<boolean> {
  const o = signupOf(payload)
  try {
    if (o.rateLimit) return (await o.rateLimit(kind, key, req)) === true
    const keyHash = hashKey(payload.secret, kind, key)
    const since = new Date(Date.now() - HOUR).toISOString()
    const { totalDocs } = await payload.count({ collection: o.attempts as CollectionSlug, where: { and: [{ kind: { equals: kind } }, { keyHash: { equals: keyHash } }, { at: { greater_than: since } }] }, overrideAccess: true })
    if (totalDocs >= o.limits[kind]) return false
    await payload.create({ collection: o.attempts as CollectionSlug, data: { kind, keyHash, at: new Date().toISOString() } as never, ...sys })
    return true
  } catch (error) {
    payload.logger.error({ err: error, msg: `signup: rate limit (${kind}) not checked, so refused` })
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// Emails, after the work is saved: a failed email never undoes it, and is logged.

async function send(payload: Payload, to: string, build: () => Promise<{ subject: string; html: string; text: string }> | { subject: string; html: string; text: string }) {
  try {
    const mail = await build()
    await payload.sendEmail({ to, subject: mail.subject, html: mail.html, text: mail.text })
  } catch (error) {
    payload.logger.error({ err: error, msg: 'signup: an email was not sent' })
  }
}

const origin = (payload: Payload) => (payload.config.serverURL || '').replace(/\/$/, '')
const urls = (payload: Payload) => {
  const o = signupOf(payload)
  return {
    verify: (token: string) => o.urls?.verify?.(token) ?? `${origin(payload)}/api/signup/verify?token=${encodeURIComponent(token)}`,
    signIn: o.urls?.signIn ?? `${origin(payload)}/admin/login`,
    reset: o.urls?.resetPassword ?? `${origin(payload)}/admin/forgot`,
  }
}

// ---------------------------------------------------------------------------------------------
// Submit

/** What a taken request answers. `setCookies` is there only when a check asked for cookies. */
export type SubmitResult = { ok: true; message: string; setCookies?: string[] }

export type SignupInput = {
  email?: unknown
  /** The request's details, checked against the site's `fields` and kept with the request. */
  details?: unknown
  /** Answers only the site's checks see, never stored (for example a birth month and year for an age gate). */
  answers?: unknown
  humanToken?: string
}

/**
 * Take a sign-up request. No account and no password yet: the account is made when the address's owner confirms
 * and chooses a password (`verifySignup`), so nobody can set up an account under someone else's address.
 *
 * Refusals the person can act on (mode, a bad email, a site check, too many tries) throw a `SignupError`.
 * Everything else ends in the same `{ ok: true }` and an email, whether the address is new, already has an
 * account, or is already waiting: the form never tells. Each case does the same lookups.
 *
 * Cookies the checks ask for come back as `setCookies`, on the result or on the refusal (`SignupError`), for the
 * response. Sign-up's own endpoint sets them; a site's own form should too.
 */
export async function submitSignup(payload: Payload, input: SignupInput, req: Req = {}): Promise<SubmitResult> {
  const o = signupOf(payload)
  const r = await requestFor(payload, req)
  const { mode, message } = await currentMode(payload)
  if (mode === 'closed' || mode === 'invite-only') throw new SignupError(mode === 'closed' ? 'closed' : 'inviteOnly', message ?? 'Sign-up is closed for now.', 403)

  const address = o.clientAddress(r)
  if (o.verifyHuman) {
    let human = false
    try {
      human = (await o.verifyHuman({ token: input.humanToken, address, req: r })) === true
    } catch (error) {
      payload.logger.error({ err: error, msg: 'signup: the human check failed, so refused' })
    }
    if (!human) throw new SignupError('human', 'Please confirm you\'re a person, then try again.')
  }
  // Without a known address, every such request shares one "unknown" count rather than skipping the limit.
  if (!(await allowed(payload, 'site', 'all', r)) || !(await allowed(payload, 'address', address ?? 'unknown', r)))
    throw new SignupError('busy', 'Too many sign-up requests right now. Please try again in an hour.', 429)

  const email = normalizeEmail(input.email)
  if (!validEmail(email)) throw new SignupError('email', 'Please enter a valid email address.')
  const asObject = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
  const details = asObject(input.details)
  const answers = asObject(input.answers)

  // Site checks (an age gate, for example). A refusal is shown; a check that breaks refuses (fail closed).
  // Cookies a check asks for (a "stay blocked" cookie, say) go out with the answer, refusals included.
  const flags: string[] = []
  const setCookies: string[] = []
  const withCookies = (error: SignupError) => (setCookies.length ? Object.assign(error, { setCookies: [...setCookies] }) : error)
  const taken = (): SubmitResult => ({ ok: true, message: RECEIVED, ...(setCookies.length ? { setCookies: [...setCookies] } : {}) })
  let userData: Record<string, unknown> = {}
  for (const check of o.checks) {
    let result
    try {
      result = (await check({ data: details, answers, email, req: r, payload })) ?? {}
      setCookies.push(...cookiesOf(result.setCookies))
    } catch (error) {
      payload.logger.error({ err: error, msg: 'signup: a site check failed, so refused' })
      throw withCookies(new SignupError('checkFailed', 'We couldn\'t take your request just now. Please try again later.', 503))
    }
    if (result.refuse) throw withCookies(new SignupError('refused', result.refuse))
    if (result.flag) flags.push(result.flag)
    if (result.userData) userData = { ...userData, ...result.userData }
  }

  const scope = o.scopeField ? await (o.scopeFor?.(r) ?? null) : null
  if (o.scopeField && (scope === null || scope === undefined)) throw withCookies(new SignupError('closed', 'Sign-up is closed for now.', 403))

  // Per-email limit: past it, quietly do nothing (the same answer as any other request).
  if (!(await allowed(payload, 'email', email, r))) return taken()

  const token = newToken()
  const outcome = await transaction(payload, r, async (tx) => {
    const rq = asReq(payload, tx)
    // The same three lookups in every case, so the answer's timing says little about the address.
    const existing = ((await payload.find({ collection: o.users as CollectionSlug, where: { email: { equals: email } }, limit: 1, pagination: false, ...sys, req: rq })).docs as Doc[])[0]
    const declined = await payload.count({ collection: o.requests as CollectionSlug, where: { and: [{ email: { equals: email } }, { status: { equals: 'declined' } }] }, overrideAccess: true, req: rq })
    const open = ((await payload.find({ collection: o.requests as CollectionSlug, where: { and: [{ email: { equals: email } }, { status: { equals: 'unverified' } }] }, limit: 1, pagination: false, ...sys, req: rq })).docs as Doc[])[0]
    if (existing) return (existing.signupStatus ?? 'active') === 'active' ? 'hasAccount' : 'nothing'
    // A decline stands for its retention time: asking again in that time changes nothing.
    if (declined.totalDocs) return 'nothing'
    const request = {
      email,
      status: 'unverified',
      details,
      flag: flags.join('; ') || null,
      userData,
      user: null,
      tokenHash: hashToken(payload.secret, token),
      tokenExpires: new Date(Date.now() + o.verifyHours * HOUR).toISOString(),
      ...(o.scopeField ? { [o.scopeField]: scope } : {}),
    }
    // One open request per address: a repeat before confirming replaces the earlier one (new details, new link).
    if (open) await payload.update({ collection: o.requests as CollectionSlug, id: open.id, data: request as never, ...sys, context: internal, req: rq })
    else await payload.create({ collection: o.requests as CollectionSlug, data: request as never, ...sys, context: internal, req: rq })
    return 'verify'
  })

  const u = urls(payload)
  const name = typeof details.name === 'string' ? details.name : undefined
  if (outcome === 'verify') await send(payload, email, () => o.emails.verify({ email, name, url: u.verify(token), hours: o.verifyHours, req: r, payload }))
  if (outcome === 'hasAccount') await send(payload, email, () => o.emails.alreadyHasAccount({ email, name, signInURL: u.signIn, resetURL: u.reset, req: r, payload }))
  return taken()
}

// ---------------------------------------------------------------------------------------------
// Verify

export type VerifyInput = { token?: unknown; password?: unknown }

/**
 * Confirm the email from the link, choosing the account's password: only the person with the inbox can do this,
 * so the account belongs to the address's owner. The account is made now: waiting for approval, or (open mode)
 * active at once. If sign-up was shut since they asked, the request still waits for staff.
 */
export async function verifySignup(payload: Payload, input: VerifyInput, req: Req = {}): Promise<{ status: 'pending' | 'active' }> {
  const o = signupOf(payload)
  const r = await requestFor(payload, req)
  const address = o.clientAddress(r)
  if (!(await allowed(payload, 'verify', address ?? 'unknown', r))) throw new SignupError('busy', 'Too many tries. Please try again in an hour.', 429)
  const bad = new SignupError('badLink', 'This link has expired or was already used. You can ask again from the sign-up page.')
  const token = input?.token
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw bad
  const password = typeof input?.password === 'string' ? input.password : ''
  if (password.length < o.minPasswordLength) throw new SignupError('password', `Please choose a password of at least ${o.minPasswordLength} characters.`)
  if (password.length > 256) throw new SignupError('password', 'Please choose a password of 256 characters or fewer.')
  const { mode } = await currentMode(payload)

  let queued: Req | null = null
  const result = await transaction(payload, r, async (tx) => {
    const rq = asReq(payload, tx)
    const where: Where = { and: [{ tokenHash: { equals: hashToken(payload.secret, token) } }, { status: { equals: 'unverified' } }] }
    const request = ((await payload.find({ collection: o.requests as CollectionSlug, where, limit: 1, pagination: false, ...sys, req: rq })).docs as Doc[])[0]
    if (!request || !request.tokenExpires || new Date(request.tokenExpires).getTime() < Date.now()) throw bad
    // An account made for this address since they asked (an invitation, say): theirs already; nothing to make.
    const existing = await payload.count({ collection: o.users as CollectionSlug, where: { email: { equals: request.email } }, overrideAccess: true, req: rq })
    if (existing.totalDocs) throw new SignupError('hasAccount', 'This address already has an account. Sign in, or set a new password if you\'ve forgotten it.', 409)
    const details = (request.details ?? {}) as Record<string, unknown>
    const user = (await payload.create({
      collection: o.users as CollectionSlug,
      data: { ...o.toUser(details), ...((request.userData ?? {}) as Record<string, unknown>), email: request.email, password, signupStatus: 'pending' } as never,
      ...sys,
      req: rq,
    })) as Doc
    const verified = { ...request, status: 'pending', user: user.id, verifiedAt: new Date().toISOString(), tokenHash: null, tokenExpires: null }
    if (mode === 'open') {
      const decided = await decide(payload, verified, 'approved', tx)
      queued = tx
      await payload.update({ collection: o.requests as CollectionSlug, id: request.id, data: decided as never, ...sys, context: internal, req: rq })
      return { status: 'active' as const, request }
    }
    await payload.update({ collection: o.requests as CollectionSlug, id: request.id, data: verified as never, ...sys, context: internal, req: rq })
    return { status: 'pending' as const, request }
  })

  const name = typeof result.request.details?.name === 'string' ? result.request.details.name : undefined
  const email = result.request.email as string
  if (result.status === 'pending') await send(payload, email, () => o.emails.pending({ email, name, req: r, payload }))
  // Approved (open mode): `decide` queued the email; it goes now that the transaction has committed.
  else if (queued) await flushAfterCommit(queued)
  return { status: result.status }
}

// ---------------------------------------------------------------------------------------------
// Decide

/**
 * Approve or decline a waiting request, inside the caller's transaction: approving activates the account and runs
 * the site's `onApprove`; declining deletes the account (it never signed in). Returns the request's new data. The
 * email goes after the transaction commits; a failed email is logged and doesn't undo the decision.
 */
export async function decide(payload: Payload, request: Doc, to: 'approved' | 'declined', req: Req): Promise<Doc> {
  const o = signupOf(payload)
  const userID = idOf(request.user)
  const by = req.user && req.user.collection === o.users ? idOf(req.user) : null
  const r = asReq(payload, req)
  const name = typeof request.details?.name === 'string' ? request.details.name : undefined
  if (to === 'approved') {
    if (userID === null) throw new SignupError('noAccount', 'This request has no account to approve.')
    const user = (await payload.update({ collection: o.users as CollectionSlug, id: userID, data: { signupStatus: 'active' } as never, ...sys, req: r })) as Doc
    await o.onApprove?.({ user, request, req: r, payload })
    after(req, () => send(payload, request.email, () => o.emails.approved({ email: request.email, name, signInURL: urls(payload).signIn, req: r, payload })))
  } else {
    if (userID !== null) await payload.delete({ collection: o.users as CollectionSlug, id: userID, ...sys, req: r })
    const note = typeof request.note === 'string' && request.note.trim() ? request.note.trim() : undefined
    after(req, () => send(payload, request.email, () => o.emails.declined({ email: request.email, name, note, req: r, payload })))
  }
  return { ...request, status: to, decidedAt: new Date().toISOString(), decidedBy: by, user: to === 'declined' ? null : userID, tokenHash: null, tokenExpires: null }
}

/**
 * Emails `decide` leaves for after the work is saved. They're kept on the request object itself (Payload gives
 * each hook its own context object, but the same req), and sent by the requests collection's afterChange, or by
 * the plugin's own flows once their transaction commits. Work that rolls back never reaches afterChange.
 */
const QUEUE = Symbol.for('signup.afterCommit')
type Queued = { [QUEUE]?: (() => Promise<unknown>)[] }
function after(req: Req, fn: () => Promise<unknown>) {
  const r = req as Queued
  ;(r[QUEUE] ??= []).push(fn)
}

/** Send what `decide` queued on this request. */
export async function flushAfterCommit(req: Req) {
  const jobs = ((req as Queued)[QUEUE] ?? []).splice(0)
  for (const job of jobs) await job()
}

// ---------------------------------------------------------------------------------------------
// Retention

/**
 * Delete what's past its time: requests decided, abandoned or never confirmed more than `retentionDays` ago, and
 * rate-limit counts older than a day. Waiting requests are kept until
 * someone decides them. Run it daily, from the site's scheduled job.
 */
export async function pruneSignupRequests(payload: Payload, now = new Date()): Promise<{ requests: number; attempts: number }> {
  const o = signupOf(payload)
  const cutoff = new Date(now.getTime() - o.retentionDays * DAY).toISOString()
  const where: Where = {
    or: [
      { and: [{ status: { in: ['approved', 'declined'] } }, { decidedAt: { less_than: cutoff } }] },
      { and: [{ status: { equals: 'unverified' } }, { createdAt: { less_than: cutoff } }] },
    ],
  }
  const old = (await payload.find({ collection: o.requests as CollectionSlug, where, pagination: false, ...sys })).docs as Doc[]
  // Unconfirmed requests have no account (one is made only on confirming); declined ones lost theirs at the decision.
  for (const request of old) await payload.delete({ collection: o.requests as CollectionSlug, id: request.id as ID, ...sys })
  const attempts = await payload.delete({ collection: o.attempts as CollectionSlug, where: { at: { less_than: new Date(now.getTime() - DAY).toISOString() } }, ...sys })
  return { requests: old.length, attempts: attempts.docs.length }
}
