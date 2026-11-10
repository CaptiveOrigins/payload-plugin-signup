import type { Emails } from './types.js'
import { plainEmail } from './util.js'

/** Plain defaults. Sites pass their own, branded versions with `emails`. */
export const defaultEmails: Emails = {
  verify: ({ url, hours }) =>
    plainEmail('Confirm your email to finish signing up', [
      'Someone asked for an account with this email address. If that was you, confirm it here:',
      url,
      `The link works for ${hours} hours. If you didn't ask, you can ignore this email and nothing will happen.`,
    ]),
  pending: () =>
    plainEmail('Thanks, your request is in', [
      'Your email is confirmed and your request is waiting for a person to look at it.',
      'We\'ll email you as soon as it\'s decided. You don\'t need to do anything else.',
    ]),
  approved: ({ signInURL }) => plainEmail('You\'re in', ['Your account is ready. Sign in with the email and password you chose:', signInURL]),
  declined: ({ note }) =>
    plainEmail('About your account request', [
      'Thank you for asking. We can\'t open an account for you at the moment.',
      ...(note ? [note] : []),
      'Your request and the details you gave us will be deleted.',
    ]),
  alreadyHasAccount: ({ signInURL, resetURL }) =>
    plainEmail('You already have an account', [
      'Someone asked for a new account with this email address, but you already have one.',
      `Sign in here: ${signInURL}`,
      `If you've forgotten your password, you can set a new one here: ${resetURL}`,
      'If you didn\'t ask, you can ignore this email.',
    ]),
}
