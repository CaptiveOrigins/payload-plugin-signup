import { createHash, randomBytes } from 'node:crypto'

import { APIError, createLocalReq, type Payload, type PayloadRequest } from 'payload'

import type { ID, Req, ResolvedSignup } from './types.js'

/** A refusal the person sees, with a code for the site to branch on. */
export class SignupError extends APIError<{ code: string }> {
  code: string
  /** `Set-Cookie` values from the site's checks, for the response that carries this refusal. */
  setCookies?: string[]
  constructor(code: string, message: string, status = 400) {
    super(message, status, { code }, true)
    this.code = code
  }
}

export const signupOf = (payload: Payload): ResolvedSignup => {
  const o = payload.config.custom?.signup as ResolvedSignup | undefined
  if (!o) throw new Error('Sign-up: the plugin is not configured on this site.')
  return o
}

export const normalizeEmail = (email: unknown) => (typeof email === 'string' ? email.trim().toLowerCase() : '')
export const validEmail = (email: string) => email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)

/** A random token for a link, and the hash that's stored instead of it. */
export const newToken = () => randomBytes(32).toString('base64url')
export const hashToken = (secret: string, token: string) => createHash('sha256').update(`${secret}:signup:${token}`).digest('hex')
/** Keys for rate limits are stored hashed, never as raw addresses or emails. */
export const hashKey = (secret: string, kind: string, key: string) => createHash('sha256').update(`${secret}:signup-limit:${kind}:${key}`).digest('hex')

export const idOf = (v: unknown): ID | null => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'object') return ((v as { id?: ID }).id ?? null) as ID | null
  return v as ID
}

/**
 * The default client address: `x-real-ip` when present (set by the host's proxy, such as Vercel's), else the last
 * `x-forwarded-for` entry, which is the one a single trusted proxy appended. Earlier entries come from the visitor
 * and can say anything. Behind any other arrangement of proxies, pass your own `clientAddress`.
 */
export const defaultClientAddress = (req: Req): string | null => {
  const h = req.headers
  const real = h?.get?.('x-real-ip')?.trim()
  if (real) return real
  return h?.get?.('x-forwarded-for')?.split(',').at(-1)?.trim() || null
}

/** Run `fn` in a transaction, or inside the caller's when `req` already has one. */
export async function transaction<T>(payload: Payload, req: Req | undefined, fn: (req: Req) => Promise<T>): Promise<T> {
  // Copies of req share one context object, so work queued inside (emails) is seen outside.
  if (req) req.context ??= {}
  const base = { ...(req ?? {}), headers: req?.headers, payload } as Req
  if (base.transactionID) return fn(base)
  const id = (await payload.db.beginTransaction?.()) ?? undefined
  const r = { ...base, transactionID: id } as Req
  try {
    const out = await fn(r)
    if (id) await payload.db.commitTransaction(id)
    return out
  } catch (error) {
    if (id) await payload.db.rollbackTransaction(id).catch(() => undefined)
    throw error
  }
}

/** The request Payload operations want, from a partial one. The copy keeps `headers`, a getter a spread would drop. */
export const asReq = (payload: Payload, req: Req) => ({ ...req, headers: req.headers, payload }) as PayloadRequest

/**
 * The request itself, never a copy: a spread drops the getters of the request Payload made (`headers` among them),
 * so checks and limits would see no headers and no client address. A request Payload made is used as it is. A
 * partial one (a site calling `submitSignup` from its own code) is completed in place by Payload's `createLocalReq`.
 */
export async function requestFor(payload: Payload, req: Req = {}): Promise<PayloadRequest> {
  if (req.payload && req.payloadAPI && req.headers) return req as PayloadRequest
  return createLocalReq({ req }, payload)
}

/**
 * The `Set-Cookie` values a check returned. Only printable ASCII (space to `~`), as RFC 6265's cookie syntax allows:
 * anything else (a line break, a control character, any character past `~`) is a broken check, and refuses before
 * anything is stored or emailed, rather than failing later when the header is set.
 */
export function cookiesOf(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || !value.every((c) => typeof c === 'string' && /^[\x20-\x7e]+$/.test(c)))
    throw new Error('Sign-up: a check returned setCookies that are not a list of printable ASCII strings.')
  return [...value]
}

/**
 * Run a check with a response-header list of its own, so it can't add headers to Sign-up's response through
 * `req.responseHeaders` (Payload's router sends that list). Cookies go through `setCookies`, which are checked.
 * The request's own list (an auth strategy's refreshed cookie, say) is put back as it was.
 */
export async function withOwnResponseHeaders<T>(req: PayloadRequest, fn: () => T | Promise<T>): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(req, 'responseHeaders')
  const own = req.responseHeaders
  req.responseHeaders = new Headers()
  try {
    return await fn()
  } finally {
    if (had) req.responseHeaders = own
    else delete req.responseHeaders
  }
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
/** Plain paragraphs as both text and simple HTML. */
export const plainEmail = (subject: string, paragraphs: string[]) => ({
  subject,
  text: paragraphs.join('\n\n'),
  html: paragraphs.map((p) => `<p>${escape(p).replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')}</p>`).join('\n'),
})
