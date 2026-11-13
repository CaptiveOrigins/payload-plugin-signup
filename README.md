# payload-plugin-signup

Sign-up for Payload: open, approval, invite-only or closed, switched in the admin. Requests are verified by email and wait as disabled accounts for an approve or decline, with no account enumeration.

**Status:** 0.1.0 is on npm. 0.1.1 (the confirm page's details, checks again at confirm, the request itself handed to checks, and cookies from checks) is on main, not released yet. 55 tests pass against a real MongoDB (in memory, single-node replica set) on Payload 3.92: every mode, confirming, approving and declining, that nobody can set up an account under someone else's address, the same answer for every address, refusals that fail closed (at asking and at confirming), rate limits (including through the real endpoints), what staff and members can and can't see or change, rollback, and retention. An independent security read found two problems before release, both fixed and tested (see [docs/decisions.md](docs/decisions.md)). Nothing has run on a real site yet, and no real email has been sent: the tests capture email. Integration into the Captive Origins platform is next.

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
- **Your checks** run before anything is stored, for example an age gate. A check can refuse with a message, flag the request for staff ("minor"), or add values to the new account. Answers meant only for checks (`answers`, such as a birth month and year) are never stored. A check that breaks refuses the request. See [Checks](#checks).
- **Checks again at confirm** (`confirmChecks`, optional): run when the person confirms, before the account is made, with the stored details and flag but never the check-only answers. A refusal declines the request; a check that breaks refuses for now and the link still works later.
- **Rate limits** per network address, per email and site-wide. Past the email limit, nothing happens, with the same answer. Use your own limiter, or the built-in one, which stores only hashed keys. A limiter that breaks refuses.
  - Which address counts: by default, `x-real-ip` when the request has it (Vercel sets it), otherwise the last `x-forwarded-for` entry, the one added by the proxy in front of the site. That's only right behind one trusted proxy that sets one of these. Behind several proxies, a CDN with its own header, or no proxy at all (where a visitor can send any of these headers), pass `clientAddress` with the header your host vouches for. Requests with no address share one "unknown" count.
  - The site-wide limit (200 an hour) is a cheap way for anyone to block sign-up for an hour. On a public site, use `verifyHuman` (Turnstile or similar) as well.
- **No back door:** once a site has users, an account can't be created by a signed-out API call. Accounts come through sign-up, from staff, or from your own code.
- **Retention:** requests decided, abandoned or never confirmed are deleted after 90 days (`retentionDays`), with any account that was never confirmed. Waiting requests stay until someone decides them. Run `pruneSignupRequests(payload)` daily.
- **A human check** (Turnstile or similar) through `verifyHuman`. Nothing is wired by default; on a public site, wire one.
- **Who manages it is yours to say, and required.** `access.manage` decides who sees and decides requests and changes the mode, and only an exact `true` counts: see [Access](#access). The plugin won't start without it, so a site can't leave the queue open to every signed-in member. `signupStatus` is shown only to the account itself and to managers. What checks set for the account (a minor flag, say) is kept out of the queue's view.

## On its own, and with others

**On its own:** it needs a users auth collection, Payload's email, and your `access.manage`. Checks, roles on approval and a human check are functions you pass in. It imports no other Captive Origins plugin.

**Works with:**
- **Age Gate:** its `ageGateCheck` goes in `checks`. A too-young person is refused, a minor is flagged in the queue, and `minorUntil` is written to the new account. The birth month and year stay in `answers` and are never stored. Its "stay blocked" cookie comes back through `setCookies`, from Age Gate's next release. Age Gate 0.1.x set it on `req.responseHeaders`, which Sign-up doesn't pass on (see [Checks](#checks)), so with 0.1.x the cookie is not set.
- **A tenant plugin** (such as Payload's multi-tenant plugin): pass `scopeField` and `scopeFor`, and add `signup-requests` to its collections, so each site sees its own queue.

**Family:** It's part of the **Identity** family (a working draft): plugins designed to sit together for accounts and access. Age Gate is the member it's wired to today.

## Install

```sh
npm install @extantape/payload-plugin-signup
```

```ts
import { signupPlugin } from '@extantape/payload-plugin-signup'

export default buildConfig({
  plugins: [
    signupPlugin({
      fields: [
        { name: 'firstName', type: 'text', required: true },
        { name: 'lastName', type: 'text', required: true },
      ],
      toUser: (d) => ({ name: `${d.firstName} ${d.lastName}` }),
      checks: [myAgeGate], // ({ data, answers, email, req, payload }) => { refuse?, flag?, userData?, setCookies? }
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

## Checks

A check is a function in `checks`, run in order when a request comes in:

```ts
type Check = (args: { data; answers; email; req: PayloadRequest; payload }) =>
  { refuse?: string; flag?: string; userData?: Record<string, unknown>; setCookies?: string[] } | void
```

- `req` is the request itself, headers and cookies included. A check written to take less (`Partial<PayloadRequest>`) still fits. Calling `submitSignup` from your own code with a partial request, or none, is fine: Payload's `createLocalReq` completes it, with empty headers.
- `setCookies` are whole `Set-Cookie` values. `POST /api/signup/request` sets them on its response, whether the request is taken or refused. `submitSignup` hands them back as `setCookies` on its result, or on the `SignupError` it throws, so your own form can set them. Each must be printable ASCII (space to `~`), as cookie syntax allows; anything else counts as a broken check and refuses (503 `checkFailed`) before anything is stored or emailed.
- Confirm checks (`confirmChecks`) work the same way: they get the request itself, and their `setCookies` go on the `POST /api/signup/verify` response, as JSON or the page, confirmed or refused. `verifySignup` hands them back on its result or its `SignupError`.
- Nothing else about the response is a check's to change. Each check runs with an empty `req.responseHeaders` of its own, and Sign-up throws that list away afterwards, so headers a check adds there never reach the response. The request's own list (an auth strategy's, say) is put back untouched. Sign-up and its checks don't import each other: the check returns plain values.

## Endpoints

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/signup/mode` | | `{ mode, accepting, message }` |
| `POST /api/signup/request` | `{ email, details, answers?, humanToken? }` | 202 `{ ok, message }`, or an error `{ error: { code, message } }`, either with any cookies the checks set |
| `GET /api/signup/verify?token=` | | A small page: what was asked for (email and details), then choose a password and confirm |
| `POST /api/signup/verify` | `{ token, password }` as JSON, or the page's form (`token`, `password`, `confirm`) | JSON `{ status: 'pending' or 'active' }`, or a page |

Error codes: `closed`, `inviteOnly`, `email`, `password`, `passwordMismatch` (the page only), `refused`, `checkFailed`, `human`, `busy`, `badLink`, `hasAccount` (an account was made for the address since they asked). The same functions are exported for your own pages: `submitSignup`, `verifySignup`, `currentMode`, and `readSignupRequest` to show what was asked for on your confirm page (it only reads; the link still works). The confirm page shows only the email and the fields you list in `confirmShows` (default none), because a mistyped address sends the link to a stranger. Hidden fields and fields with their own read access never show.

## Access

`access.manage` decides who manages sign-up, and only an answer of exactly `true`, for a signed-in
user, counts. Anything else is a no: `false`, `1`, `'yes'`, an object, a query (`Where`), or an error
thrown or rejected. An error doesn't escape as a 500: REST answers 403, as for anyone else who isn't a
manager. It's typed as Payload's `Access` so existing rules fit, but what it returns is never passed to
Payload, so an object that looks like a query can't widen the queue to every request.

| Where | A manager | Anyone else, or signed out |
|---|---|---|
| Sign-up requests (applicants' emails and details) | Reads, decides, deletes | Nothing |
| Sign-up settings (the mode and messages) | Reads and changes | Nothing |
| An account's `signupStatus` | Reads | Only the account itself reads its own |

Nobody creates requests or changes `signupStatus` directly: the plugin does. Each site seeing only its
own queue comes from a tenant plugin with `scopeField` (above), not from a query in `access.manage`.

## Commands

```sh
npm test          # integration tests, in-memory MongoDB
npm run typecheck
npm run build
```

## License

MIT. See [LICENSE](LICENSE).
