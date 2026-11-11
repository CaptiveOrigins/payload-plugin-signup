import type { PayloadRequest } from 'payload'

import type { ResolvedSignup } from './types.js'

/** Only an answer of exactly `true` passes; anything else, a thrown error included, is no. */
export async function exactlyTrue(check: () => unknown): Promise<boolean> {
  try {
    return (await check()) === true
  } catch {
    return false
  }
}

/**
 * A signed-in manager: `access.manage` answered exactly `true`. A truthy value, a query (`Where`) or an error is a no,
 * and the site's answer is never handed to Payload, so an object can't widen access to every request.
 */
export const isManager = (o: Pick<ResolvedSignup, 'manage'>, args: { req: PayloadRequest }): Promise<boolean> =>
  args.req.user ? exactlyTrue(() => o.manage(args as never)) : Promise.resolve(false)
