import { APIError, Forbidden, type Access, type CollectionConfig, type Config, type Plugin } from 'payload'

import { attemptsCollection, requestsCollection, settingsGlobal, signupStatusField } from './collections.js'
import { defaultEmails } from './emails.js'
import { signupEndpoints } from './endpoints.js'
import { flushAfterCommit } from './flow.js'
import { MODES, type ResolvedSignup, type SignupMode, type SignupPluginOptions } from './types.js'
import { firstAddress } from './util.js'

/** The site's lock on the mode: an option, else `SIGNUP_MODE`. An unknown value locks it closed (fail shut). */
const lockedMode = (forced: SignupPluginOptions['forceMode']): SignupMode | null => {
  const v = forced === undefined ? process.env.SIGNUP_MODE?.trim() : forced
  if (!v) return null
  return MODES.includes(v as SignupMode) ? (v as SignupMode) : 'closed'
}

/**
 * Sign-up: a request form's back end with four modes (open, approval, invite-only, closed), email verification,
 * a staff queue, and retention. It adds `signupStatus` to the auth collection, and refuses sign-in to any account
 * that isn't active.
 */
export const signupPlugin =
  (options: SignupPluginOptions = {}): Plugin =>
  (config: Config): Config => {
    const users = options.users ?? config.admin?.user ?? 'users'
    const signedIn: Access = ({ req }) => Boolean(req.user && req.user.collection === users)
    const o: ResolvedSignup = {
      users,
      requests: options.slugs?.requests ?? 'signup-requests',
      settings: options.slugs?.settings ?? 'signup-settings',
      attempts: options.slugs?.attempts ?? 'signup-attempts',
      fields: options.fields ?? [],
      checks: options.checks ?? [],
      toUser: options.toUser ?? ((data) => (typeof data.name === 'string' ? { name: data.name } : {})),
      onApprove: options.onApprove,
      emails: { ...defaultEmails, ...options.emails },
      urls: options.urls,
      rateLimit: options.rateLimit,
      limits: { address: 5, email: 3, site: 200, verify: 20, ...options.limits },
      clientAddress: options.clientAddress ?? firstAddress,
      verifyHuman: options.verifyHuman,
      manage: options.access?.manage ?? signedIn,
      scopeField: options.scopeField,
      scopeFor: options.scopeFor,
      retentionDays: options.retentionDays ?? 90,
      verifyHours: options.verifyHours ?? 48,
      minPasswordLength: options.minPasswordLength ?? 10,
      forceMode: lockedMode(options.forceMode),
      adminGroup: options.adminGroup ?? 'Sign-up',
    }
    if (o.scopeField && !o.scopeFor) throw new Error('Sign-up: with `scopeField`, give `scopeFor` so each request knows its site.')

    const collections = config.collections ?? []
    const auth = collections.find((c) => c.slug === users)
    if (!auth?.auth) throw new Error(`Sign-up: "${users}" isn't an auth collection in this config. Set \`users\`.`)
    const clash = collections.filter((c) => [o.requests, o.attempts].includes(c.slug)).map((c) => c.slug)
    if (clash.length || (config.globals ?? []).some((g) => g.slug === o.settings))
      throw new Error(`Sign-up: ${[...clash, o.settings].join(', ')} already exist in this config. Give Sign-up other slugs with \`slugs\`.`)

    const withStatus: CollectionConfig = {
      ...auth,
      fields: [...auth.fields, signupStatusField()],
      hooks: {
        ...auth.hooks,
        // Accounts come through sign-up (or from staff and the site's own code), never from a signed-out API call,
        // which would skip verifying and approval. The very first user is still allowed, so a new site can start.
        beforeOperation: [
          async ({ operation, req }) => {
            if (operation !== 'create' || req.user || req.payloadAPI === 'local') return
            const { totalDocs } = await req.payload.count({ collection: users as never, overrideAccess: true })
            if (totalDocs > 0) throw new Forbidden(req.t)
          },
          ...(auth.hooks?.beforeOperation ?? []),
        ],
        // Payload runs this only after the password matched, so only the account's owner learns it's waiting.
        beforeLogin: [
          ({ user }) => {
            const status = (user as { signupStatus?: string }).signupStatus ?? 'active'
            if (status === 'active') return user
            throw new APIError(status === 'pending' ? 'Your account is waiting for approval. We\'ll email you when it\'s ready.' : 'This account can\'t sign in yet. Check your email for the link to confirm your address.', 403, { code: `signup-${status}` }, true)
          },
          ...(auth.hooks?.beforeLogin ?? []),
        ],
      },
    }
    const requests = requestsCollection(o)
    requests.hooks = { ...requests.hooks, afterChange: [async ({ req, doc }) => (await flushAfterCommit(req), doc)] }

    return {
      ...config,
      custom: { ...config.custom, signup: o },
      collections: [...collections.map((c) => (c.slug === users ? withStatus : c)), requests, attemptsCollection(o)],
      globals: [...(config.globals ?? []), settingsGlobal(o)],
      endpoints: [...(config.endpoints ?? []), ...signupEndpoints],
    }
  }
