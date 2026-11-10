import type { Access, Field, Payload, PayloadRequest } from 'payload'

export type ID = string | number
export type Req = Partial<PayloadRequest>

/**
 * How people get an account.
 * - `open`: anyone who verifies their email gets an active account.
 * - `approval`: verified requests wait as disabled accounts until staff approve or decline.
 * - `invite-only`: the form refuses; accounts come only from the site's own invitations.
 * - `closed`: the form refuses; nobody can ask.
 */
export type SignupMode = 'open' | 'approval' | 'invite-only' | 'closed'
export const MODES: SignupMode[] = ['open', 'approval', 'invite-only', 'closed']

/** A user's place in sign-up. Accounts are made on confirming, as `pending` (or `active` in open mode); accounts made any other way are `active`. */
export type SignupStatus = 'pending' | 'active'

/** A request's place in the queue. */
export type RequestStatus = 'unverified' | 'pending' | 'approved' | 'declined'

/** What a site check says about a request. Return nothing (or `{}`) to let it through. */
export type CheckResult = {
  /** Refuse, with this message shown to the person. Nothing is stored. */
  refuse?: string
  /** Let it through, but show this to staff in the queue (for example "minor"). */
  flag?: string
  /** Extra values for the new user (for example a minor flag), merged after `toUser`. */
  userData?: Record<string, unknown>
}

/** `data` is the request's details (kept); `answers` are for checks only and never stored. */
export type Check = (args: { data: Record<string, unknown>; answers: Record<string, unknown>; email: string; req: Req; payload: Payload }) => CheckResult | void | Promise<CheckResult | void>

export type Email = { subject: string; html: string; text: string }
export type EmailContext = { email: string; name?: string; req: Req; payload: Payload }
export type Emails = {
  /** The link that proves they own the address. Sent for new requests (and again on a repeat). */
  verify: (ctx: EmailContext & { url: string; hours: number }) => Email | Promise<Email>
  /** After verifying, in approval mode: "we'll be in touch". */
  pending: (ctx: EmailContext) => Email | Promise<Email>
  /** Approved, or verified in open mode: "you're in". */
  approved: (ctx: EmailContext & { signInURL: string }) => Email | Promise<Email>
  /** Declined: polite, with the optional note staff wrote for them. */
  declined: (ctx: EmailContext & { note?: string }) => Email | Promise<Email>
  /** Someone asked with an address that already has an account: sent instead of a request, so the form never tells. */
  alreadyHasAccount: (ctx: EmailContext & { signInURL: string; resetURL: string }) => Email | Promise<Email>
}

/** What a rate limit is counting. */
export type LimitKind = 'address' | 'email' | 'site' | 'verify'
/** Returns true to allow. Throwing, or anything else, refuses (fail closed). */
export type RateLimit = (kind: LimitKind, key: string, req: Req) => boolean | Promise<boolean>

export type SignupPluginOptions = {
  /** The auth collection accounts are made in. Default: `config.admin.user`, else `users`. */
  users?: string
  /** Slugs. Defaults: `signup-requests`, `signup-settings` (a global), `signup-attempts`. */
  slugs?: { requests?: string; settings?: string; attempts?: string }
  /** The request's details: plain Payload fields, validated by Payload and shown to staff. Email and password are built in. */
  fields?: Field[]
  /** Run at submit, in order. A refusal stops the request; a check that throws refuses it (fail closed). */
  checks?: Check[]
  /** Map a request's details onto the new user. Default: copies `name` when there is one. */
  toUser?: (data: Record<string, unknown>) => Record<string, unknown>
  /** After approval (or verification in open mode), inside the same transaction: give roles, memberships. Throw to refuse. */
  onApprove?: (args: { user: Record<string, unknown>; request: Record<string, unknown>; req: Req; payload: Payload }) => void | Promise<void>
  /** Email bodies. Plain-text defaults otherwise. */
  emails?: Partial<Emails>
  /** Where links point. `verifyURL` gets the token; defaults use `serverURL`. */
  urls?: { verify?: (token: string) => string; signIn?: string; resetPassword?: string }
  /** The site's rate limiter. Default: a built-in one that stores hashed keys only. */
  rateLimit?: RateLimit
  /** Built-in limiter's limits per hour. Defaults: 5 per address, 3 per email, 200 site-wide, 20 verify attempts per address. */
  limits?: Partial<Record<LimitKind, number>>
  /** The person's network address, for rate limits. Default: the first `x-forwarded-for` entry, else `x-real-ip`. */
  clientAddress?: (req: Req) => string | null
  /** A human check, such as Turnstile. Returns true for a person; false or throwing refuses. */
  verifyHuman?: (args: { token: string | undefined; address: string | null; req: Req }) => boolean | Promise<boolean>
  /** Who decides requests and changes the mode. Required: the plugin won't start without it, so a site can't leave the queue open to every signed-in member by accident. */
  access: { manage: Access }
  /** A field that separates sites, such as `tenant`. The request takes its value from `scopeFor`. */
  scopeField?: string
  /** Which site a request belongs to (with `scopeField`). Return null to refuse. */
  scopeFor?: (req: Req) => ID | null | Promise<ID | null>
  /** Days a decided, abandoned or unverified request is kept. Default 90. */
  retentionDays?: number
  /**
   * Which of your fields the confirm page shows, by name, so the person can see it's their request. Default: none,
   * only the email. Someone who mistypes their address sends the link to a stranger's inbox, so show only what's
   * safe for a stranger to read. Hidden fields and fields with their own read access are never shown.
   */
  confirmShows?: string[]
  /** Hours a verification link works. Default 48. */
  verifyHours?: number
  /** Minimum password length. Default 10. */
  minPasswordLength?: number
  /** Overrides the admin setting when set, as a hard lock. Default: `process.env.SIGNUP_MODE`. */
  forceMode?: SignupMode | null
  /** Admin group. Default 'Sign-up'. */
  adminGroup?: string
}

export type ResolvedSignup = Required<Pick<SignupPluginOptions, 'retentionDays' | 'verifyHours' | 'minPasswordLength' | 'adminGroup'>> & {
  users: string
  requests: string
  settings: string
  attempts: string
  fields: Field[]
  checks: Check[]
  toUser: NonNullable<SignupPluginOptions['toUser']>
  onApprove?: SignupPluginOptions['onApprove']
  emails: Emails
  urls: SignupPluginOptions['urls']
  rateLimit?: RateLimit
  limits: Record<LimitKind, number>
  clientAddress: NonNullable<SignupPluginOptions['clientAddress']>
  verifyHuman?: SignupPluginOptions['verifyHuman']
  manage: Access
  scopeField?: string
  scopeFor?: SignupPluginOptions['scopeFor']
  forceMode: SignupMode | null
  confirmShows: string[]
}
