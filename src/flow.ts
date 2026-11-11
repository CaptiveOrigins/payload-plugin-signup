import type { CollectionSlug, Payload, Where } from 'payload'

import type { ID, LimitKind, Req, SignupMode } from './types.js'
import { MODES } from './types.js'
import { asReq, hashKey, hashToken, idOf, newToken, normalizeEmail, signupOf, SignupError, transaction, validEmail } from './util.js'

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
 */
export async function submitSignup(payload: Payload, input: SignupInput, req: Req = {}): Promise<{ ok: true; message: string }> {
  const o = signupOf(payload)
  const r = { ...req, payload } as Req
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
  const flags: string[] = []
  let userData: Record<string, unknown> = {}
  for (const check of o.checks) {
    let result
    try {
      result = (await check({ data: details, answers, email, req: r, payload })) ?? {}
    } catch (error) {
      payload.logger.error({ err: { name: (error as Error)?.name }, msg: 'signup: a site check failed, so refused' })
      throw new SignupError('checkFailed', 'We couldn\'t take your request just now. Please try again later.', 503)
    }
    if (result.refuse) throw new SignupError('refused', result.refuse)
    if (result.flag) flags.push(result.flag)
    if (result.userData) userData = { ...userData, ...result.userData }
  }

  const scope = o.scopeField ? await (o.scopeFor?.(r) ?? null) : null
  if (o.scopeField && (scope === null || scope === undefined)) throw new SignupError('closed', 'Sign-up is closed for now.', 403)

  // Per-email limit: past it, quietly do nothing (the same answer as any other request).
  if (!(await allowed(payload, 'email', email, r))) return { ok: true, message: RECEIVED }

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
  return { ok: true, message: RECEIVED }
}

// ---------------------------------------------------------------------------------------------
// Verify

export type RequestDetail = { name: string; label: string; value: string }

/** A field's label as written in the config, in plain text. Labels given per language use English, then any. */
function labelOf(field: Record<string, any>): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  const l = field.label
  if (typeof l === 'string' && l) return l
  if (l && typeof l === 'object') {
    const text = [l.en, ...Object.values(l)].find((v) => typeof v === 'string' && v)
    if (text) return text as string
  }
  return String(field.name).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())
}

/** A stored value as words: select values show their option's label, yes/no for checkboxes, dates as dates. */
function showValue(field: Record<string, any>, value: unknown): string | null { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (value === null || value === undefined || value === '') return null
  const one = (v: unknown) => {
    const option = Array.isArray(field.options) ? field.options.find((x: unknown) => (typeof x === 'object' && x ? (x as Doc).value : x) === v) : undefined
    if (option && typeof option === 'object') return typeof option.label === 'string' ? option.label : String(v)
    return String(v)
  }
  if (field.type === 'checkbox') return value ? 'Yes' : 'No'
  if (field.type === 'date' && typeof value === 'string') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? value : d.toISOString().slice(0, 10)
  }
  if (Array.isArray(value)) return value.every((v) => ['string', 'number'].includes(typeof v)) ? value.map(one).join(', ') : null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return one(value)
  return null
}

/**
 * What the person asked for, from the link, so the confirm page can show it before they press the button: the
 * email, and the fields the site listed in `confirmShows`, as words. Only those: a mistyped address sends the link
 * to a stranger. Hidden fields and fields with their own read access are never shown, even when listed. Answers
 * meant only for checks were never stored, and what checks set for the account isn't shown. It only reads: the
 * link still works afterwards. An unknown, used or expired link gets the same `badLink` refusal as confirming would.
 * `countAttempt: false` is for a page that just counted one through `verifySignup`.
 */
export async function readSignupRequest(
  payload: Payload,
  input: { token?: unknown },
  req: Req = {},
  { countAttempt = true }: { countAttempt?: boolean } = {},
): Promise<{ email: string; details: RequestDetail[] }> {
  const o = signupOf(payload)
  const r = { ...req, payload } as Req
  if (countAttempt && !(await allowed(payload, 'verify', o.clientAddress(r) ?? 'unknown', r))) throw new SignupError('busy', 'Too many tries. Please try again in an hour.', 429)
  const bad = new SignupError('badLink', 'This link has expired or was already used. You can ask again from the sign-up page.')
  const token = input?.token
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw bad
  const where: Where = { and: [{ tokenHash: { equals: hashToken(payload.secret, token) } }, { status: { equals: 'unverified' } }] }
  const request = ((await payload.find({ collection: o.requests as CollectionSlug, where, limit: 1, pagination: false, ...sys, req: asReq(payload, r) })).docs as Doc[])[0]
  if (!request || !request.tokenExpires || new Date(request.tokenExpires).getTime() < Date.now()) throw bad
  const stored = (request.details ?? {}) as Record<string, unknown>
  const details: RequestDetail[] = []
  const listed = new Set(o.confirmShows)
  for (const field of o.fields as Record<string, any>[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (typeof field.name !== 'string' || !listed.has(field.name) || field.admin?.hidden || field.hidden || field.access?.read) continue
    const value = showValue(field, stored[field.name])
    if (value !== null) details.push({ name: field.name, label: labelOf(field), value })
  }
  return { email: request.email as string, details }
}

export type VerifyInput = { token?: unknown; password?: unknown }

/**
 * Confirm the email from the link, choosing the account's password: only the person with the inbox can do this,
 * so the account belongs to the address's owner. The account is made now: waiting for approval, or (open mode)
 * active at once. If sign-up was shut since they asked, the request still waits for staff.
 */
export async function verifySignup(payload: Payload, input: VerifyInput, req: Req = {}): Promise<{ status: 'pending' | 'active' }> {
  const o = signupOf(payload)
  const r = { ...req, payload } as Req
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
    // The site's checks again, now that the person is here: what changed since they asked counts.
    let flag: string | null = (request.flag as string | null) ?? null
    let userData = (request.userData ?? {}) as Record<string, unknown>
    for (const check of o.confirmChecks) {
      let result
      try {
        result = (await check({ data: details, email: request.email, flag, req: r, payload })) ?? {}
      } catch (error) {
        // Fail closed, and leave the request as it was, so the same link works once the check does.
        payload.logger.error({ err: { name: (error as Error)?.name }, msg: 'signup: a confirm check failed, so refused for now' })
        throw new SignupError('checkFailed', 'We couldn\'t finish this just now. Please try the same link again later.', 503)
      }
      if (result.refuse) {
        // A refusal is a decline: the link stops working and asking again changes nothing for the retention time.
        await payload.update({ collection: o.requests as CollectionSlug, id: request.id, data: { status: 'declined', decidedAt: new Date().toISOString(), tokenHash: null, tokenExpires: null } as never, ...sys, context: internal, req: rq })
        return { status: 'refused' as const, request, message: result.refuse }
      }
      if (result.flag) flag = [flag, result.flag].filter(Boolean).join('; ')
      if (result.userData) userData = { ...userData, ...result.userData }
    }
    const user = (await payload.create({
      collection: o.users as CollectionSlug,
      data: { ...o.toUser(details), ...userData, email: request.email, password, signupStatus: 'pending' } as never,
      ...sys,
      req: rq,
    })) as Doc
    const verified = { ...request, flag, userData, status: 'pending', user: user.id, verifiedAt: new Date().toISOString(), tokenHash: null, tokenExpires: null }
    if (mode === 'open') {
      const decided = await decide(payload, verified, 'approved', tx)
      queued = tx
      await payload.update({ collection: o.requests as CollectionSlug, id: request.id, data: decided as never, ...sys, context: internal, req: rq })
      return { status: 'active' as const, request }
    }
    await payload.update({ collection: o.requests as CollectionSlug, id: request.id, data: verified as never, ...sys, context: internal, req: rq })
    return { status: 'pending' as const, request }
  })

  // Refused at confirm: the decline is committed, then the person is told why. No account was made.
  if (result.status === 'refused') throw new SignupError('refused', result.message)
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
