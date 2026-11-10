# payload-plugin-signup

Sign-up for Payload: open, approval, invite-only or closed, switched in the admin. Requests are verified by email and wait as disabled accounts for an approve or decline, with no account enumeration.

**Status:** 0.1.0, not on npm yet; 0.1.1 is on the `confirm-details` branch. 33 tests pass against a real MongoDB (in memory, single-node replica set) on Payload 3.92: every mode, confirming, approving and declining, that nobody can set up an account under someone else's address, the same answer for every address, refusals that fail closed, rate limits, what staff and members can and can't see or change, rollback, and retention. An independent security read found two problems before release, both fixed and tested (see [docs/decisions.md](docs/decisions.md)). Nothing has run on a real site yet, and no real email has been sent: the tests capture email. Integration into the Captive Origins platform is next.

## What it does

- **Four modes**, chosen in **Sign-up settings** in the admin and in force at once, with no deploy:
  - **Open:** anyone who confirms their email gets an account.
  - **Approval:** a confirmed request waits as a disabled account until staff approve or decline it.
  - **Invite only:** the form refuses, with your message. Accounts come from your own invitations.
  - **Closed:** the form refuses, with your message.
  `SIGNUP_MODE` (or the `forceMode` option) locks the mode from configuration. Anything unreadable or unknown counts as closed.
- **A request** has an email and your own fields (plain Payload fields, so Payload validates them and the admin shows them). No account and no password yet. Sign-up emails a link. Opening it shows a short form: the person chooses their password and presses "Confirm my email". Opening the link alone changes nothing, because mail scanners open links. Only then is the account made, so only the person with the inbox can set one up under that address. In approval mode it can't sign in until it's approved.
- **The same answer every time:** "Thanks. Check your email to continue." That goes for a new address, one that already has an account (its owner gets an email saying so), and one that's already waiting. The form never tells anyone whether an address has an account, and each case does the same lookups, so the timing gives little away (not measured, so not promised). "Waiting for approval" is only shown at sign-in, after the password matched.
- **Staff decide in the admin.** Open a request and set Status to Approved or Declined, or select several and use Edit. A waiting request can only be approved or declined; nothing else on it can be changed. Approving activates the account, runs your `onApprove` (roles, memberships), and emails "You're in". Declining deletes the account, which never signed in, and sends a polite email with your optional note. If `onApprove` fails, nothing changes and no email goes out.
- **Your checks** run before anything is stored, for example an age gate. A check can refuse with a message, flag the request for staff ("minor"), or add values to the new account. Answers meant only for checks (`answers`, such as a birth month and year) are never stored. A check that breaks refuses the request.
- **Rate limits** per network address, per email and site-wide. Past the email limit, nothing happens, with the same answer. Use your own limiter, or the built-in one, which stores only hashed keys. A limiter that breaks refuses.
  - The address is the first `x-forwarded-for` entry by default, which a visitor can fake behind proxies that append to it. Give `clientAddress` your host's trusted header (on Vercel, `x-real-ip`). Requests with no address share one "unknown" count.
  - The site-wide limit (200 an hour) is a cheap way for anyone to block sign-up for an hour. On a public site, use `verifyHuman` (Turnstile or similar) as well.
- **No back door:** once a site has users, an account can't be created by a signed-out API call. Accounts come through sign-up, from staff, or from your own code.
- **Retention:** requests decided, abandoned or never confirmed are deleted after 90 days (`retentionDays`), with any account that was never confirmed. Waiting requests stay until someone decides them. Run `pruneSignupRequests(payload)` daily.
- **A human check** (Turnstile or similar) through `verifyHuman`. Nothing is wired by default; on a public site, wire one.
- **Who manages it is yours to say, and required.** `access.manage` decides who sees and decides requests and changes the mode. The plugin won't start without it, so a site can't leave the queue open to every signed-in member. `signupStatus` is shown only to the account itself and to managers. What checks set for the account (a minor flag, say) is kept out of the queue's view.

## Install

```sh
npm install @captiveorigins/payload-plugin-signup
```

```ts
import { signupPlugin } from '@captiveorigins/payload-plugin-signup'

export default buildConfig({
  plugins: [
    signupPlugin({
      fields: [
        { name: 'firstName', type: 'text', required: true },
        { name: 'lastName', type: 'text', required: true },
      ],
      toUser: (d) => ({ name: `${d.firstName} ${d.lastName}` }),
      checks: [myAgeGate], // ({ data, answers, email, req, payload }) => { refuse?, flag?, userData? }
      onApprove: async ({ user, req, payload }) => {
        /* give roles */
      },
      access: { manage: ({ req }) => req.user?.role === 'admin' }, // required
      emails: { verify: myBrandedVerifyEmail }, // any of verify, pending, approved, declined, alreadyHasAccount
      urls: { signIn: 'https://example.com/login', resetPassword: 'https://example.com/forgot-password' },
    }),
  ],
})
```

Build the collections' indexes before first use (`signup-requests`, `signup-attempts`, and the new `signupStatus` on your users). If you build your own confirm page, show what was asked for with `readSignupRequest`, ask for the password there and post `{ token, password }`; never confirm when the page loads. With a tenant plugin, pass `scopeField` and `scopeFor`, and add `signup-requests` to your tenant plugin's collections, so each site sees its own queue. The mode setting is one for the whole install.

## Endpoints

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/signup/mode` | | `{ mode, accepting, message }` |
| `POST /api/signup/request` | `{ email, details, answers?, humanToken? }` | 202 `{ ok, message }`, or an error `{ error: { code, message } }` |
| `GET /api/signup/verify?token=` | | A small page: what was asked for (email and details), then choose a password and confirm |
| `POST /api/signup/verify` | `{ token, password }` as JSON, or the page's form (`token`, `password`, `confirm`) | JSON `{ status: 'pending' or 'active' }`, or a page |

Error codes: `closed`, `inviteOnly`, `email`, `password`, `passwordMismatch` (the page only), `refused`, `checkFailed`, `human`, `busy`, `badLink`, `hasAccount` (an account was made for the address since they asked). The same functions are exported for your own pages: `submitSignup`, `verifySignup`, `currentMode`, and `readSignupRequest` to show what was asked for on your confirm page (it only reads; the link still works). The confirm page shows only the email and the fields you list in `confirmShows` (default none), because a mistyped address sends the link to a stranger. Hidden fields and fields with their own read access never show.

## Commands

```sh
npm test          # integration tests, in-memory MongoDB
npm run typecheck
npm run build
```

## License

MIT. See [LICENSE](LICENSE).
