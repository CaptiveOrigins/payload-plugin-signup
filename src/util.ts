import { createHash, randomBytes } from 'node:crypto'

import { APIError, type Payload, type PayloadRequest } from 'payload'

import type { ID, Req, ResolvedSignup } from './types.js'

/** A refusal the person sees, with a code for the site to branch on. */
export class SignupError extends APIError<{ code: string }> {
  code: string
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

export const firstAddress = (req: Req): string | null => {
  const h = req.headers
  const forwarded = h?.get?.('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || h?.get?.('x-real-ip')?.trim() || null
}

/** Run `fn` in a transaction, or inside the caller's when `req` already has one. */
export async function transaction<T>(payload: Payload, req: Req | undefined, fn: (req: Req) => Promise<T>): Promise<T> {
  // Copies of req share one context object, so work queued inside (emails) is seen outside.
  if (req) req.context ??= {}
  const base = { ...(req ?? {}), payload } as Req
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

/** The request Payload operations want, from a partial one. */
export const asReq = (payload: Payload, req: Req) => ({ ...req, payload }) as PayloadRequest

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
/** Plain paragraphs as both text and simple HTML. */
export const plainEmail = (subject: string, paragraphs: string[]) => ({
  subject,
  text: paragraphs.join('\n\n'),
  html: paragraphs.map((p) => `<p>${escape(p).replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')}</p>`).join('\n'),
})
