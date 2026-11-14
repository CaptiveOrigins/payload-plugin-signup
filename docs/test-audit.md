# Test audit

Newest first.

## 2026-11-11: the security read on d2e758a

Suite: 49 tests before, 55 after (`npx vitest run`; the race test was written first and failed with a Mongo write conflict).

- **Tests added.** A cookie with a character past `~` refuses with 503 and stores and emails nothing: on a taken request, on a refusal, and at confirm. Headers a check adds through `req.responseHeaders` don't reach the request or verify response, and a request's own list is put back untouched. With `x-real-ip`, faked first `x-forwarded-for` entries share one count; without it, the last entry counts. Two confirms of one link at once: one account, and the other gets `badLink`. Signed-out create with `signupInternal` as `'true'`, `1`, `{}` or `'yes'` is refused.
- **Mutation checks.** 8 mutations, each a Python string replace, restored exactly (checked by SHA-256). All 8 fail the suite: the old cookie check; `x-real-ip` ignored; the first `x-forwarded-for` entry; the race not handled; a truthy internal mark; the empty list not given; the request's own list not put back; checks run without the helper.
- **Skipped.** Without transactions (no replica set) the race isn't a database conflict; that case was accepted in the confirm-checks security read and isn't tested.

## 2026-11-11: after merging confirm-checks, the confirm paths too

Suite: 44 tests after the merge, 48 now (`npx vitest run`).

- **The gaps.** `readSignupRequest` still copied the request, so its rate limit counted every reader as "unknown". Confirm checks could return `setCookies`, but nothing set them. No test confirmed through `POST /api/signup/verify` as a real REST request, and doing so found a third bug: the guard against signed-out account creation (`payloadAPI` is `REST`) also refused Sign-up's own create, a 500 for every confirm once a site had users.
- **The change.** `readSignupRequest` uses `requestFor`. Confirm checks get the request itself and their cookies go on the verify response (JSON and page, confirmed and refused) and on `verifySignup`'s result and error. Sign-up's own user create carries `context.signupInternal`, which the guard lets through; a signed-out REST create is still refused (the existing test).
- **Tests added.** Through the real endpoint: confirm checks see the request's cookie and address; a confirm check's cookie on a 200, a JSON 400 refusal and a page refusal; a cookie with a line break refuses with 503, sets nothing and makes no account; `verifySignup` returns the cookies; reads of the confirm page counted by address.
- **Mutation checks.** 7 mutations, each a Python string replace, restored exactly (checked by SHA-256). All 7 fail the suite: `readSignupRequest` copying; confirm cookies not collected; the JSON answer, the refusal and the error page each dropping them; confirm checks handed a copy; the create not marked internal.

## 2026-11-11: the request itself reaches checks; checks may set cookies

Suite: 30 tests before, 36 after (`npx vitest run`). Prompted by the combo test with Age Gate (branch `combo-tests`), which found that the endpoint broke the pairing.

- **The gaps.** Every test called `submitSignup` directly with a plain object, so nothing went through `POST /api/signup/request` with a real request. There, `{ ...req, payload }` dropped Payload's `headers` getter: checks saw no headers (Age Gate threw, so everyone got 503), and the limiter saw no address (one "unknown" count for the whole site). A check had no way to set a cookie on the response.
- **The change.** `requestFor` (`src/util.ts`) uses Payload's request as it is and completes a partial one with `createLocalReq`; `submitSignup` and `verifySignup` use it. Copies made for transactions keep `headers`. `CheckResult.setCookies`, set by the endpoint on taken and refused requests, handed back on the result and on `SignupError`.
- **Tests added.** Through the real endpoint: two addresses get separate built-in limiter counts (the third from one address is 429, the other address still 202); a check sees the request's cookie and address; confirm attempts are counted by address too; a check's cookies are set on a 202 and on a 400 refusal and stay out of the body; `submitSignup` returns them on the result and the error; a cookie with a line break, or not a list, refuses with 503 and sets nothing.
- **Mutation checks.** 6 mutations, each a Python string replace, restored exactly (checked by SHA-256). All 6 fail the suite: the spread copy put back in `submitSignup` (3 tests fail) and in `verifySignup` (1); the endpoint not setting the cookies; no validation of `setCookies`; a refusal without its cookies; cookies not collected.
- **Skipped.** `verifySignup` through the endpoint with a header-reading hook: no check runs at confirm on this branch.

## 2026-11-11: only an exact `true` from `access.manage` passes

Suite: 28 tests before, 30 after (`npx vitest run`, real Payload, in-memory MongoDB, made-up applicants at example.com). Prompted by an access-control sweep across the plugins; the fix follows payload-plugin-sponsors.

- **The gap.** `access.manage` was passed raw as the read, update and delete access of sign-up requests (applicants' emails and details) and as the settings global's read and update. A truthy answer like `1` was a yes, an object was read by Payload as a query (so `{ email: { exists: true } }` would list every request), and a throw became a 500. `signupStatus` already required `=== true`.
- **The change.** `src/access.ts`: `exactlyTrue` (only `true` passes; a throw or rejection is `false`) and `isManager` (signed in, and `access.manage` answered exactly `true`). The requests collection, the settings global and `signupStatus` all use it. `access.manage` stays typed as Payload's `Access`; its answer is never passed to Payload.
- **Tests.** "only an exact yes from access.manage": each of `1`, `'yes'`, `{}`, a query-shaped object, a thrown error and a rejected promise. Staff can't list, read, decide or delete requests, read or change the settings, or see another account's `signupStatus`; nothing changes. Signed out is a no even with `true`. With `true`, staff see every request and the settings, and decide. REST through `handleEndpoints` with a real login and a throwing `access.manage`: 403 for the queue and the settings, never a 500; 200 with `true`.
- **Mutation checks.** 9 mutations, each a Python string replace on the file, restored byte for byte (checked by SHA-256). All 9 fail the suite: truthy passing in `exactlyTrue`; errors rethrown; `isManager` without its sign-in check; the raw `o.manage` put back at requests read, update and delete and settings read and update; a truthy `signupStatus` check.
- **Skipped.** Per-site queues under a tenant plugin come from that plugin's access, not this one, and aren't tested here.

## 2026-11-10: confirm checks (0.1.1)

| Promise | Test |
| --- | --- |
| A refusal at confirm declines: no account, the stored link hash cleared, asking again changes nothing | `checks again at confirm > declines at confirm…` |
| A confirm check that breaks refuses for now; the request and the same link still work later | `… > refuses for now when a confirm check breaks…` |
| Confirm checks see details and the flag, never check-only answers; their flag and user data are kept | `… > sees the stored details and flag…` |

Mutation check: 5 of 5 guards caught, after adding a check that the token hash is cleared in the stored row (it first survived, because the status filter alone also kills the link). Skipped: confirm checks in open mode separately, since the checks run before the mode is looked at.

## 2026-11-10: second audit, after the security read

The security read's two required fixes changed the flow (the password is chosen when confirming; `access.manage` is required). Tests rewritten to match, and these added:

- Refusing to start without `access.manage`.
- Asking with someone else's address gives the asker nothing; the owner's password is the only one that works.
- An address that got an account (an invitation) between asking and confirming: nothing new is made.
- A signed-in member who isn't staff can't read the queue or the settings, change the mode, or decide a request.
- `signupStatus` shown only to the account and to staff; checks' `userData` never shown in the queue.
- A request with no network address counts under "unknown".
- The confirm page asks for the password twice; a mismatch keeps the form and makes nothing.

28 tests.

## 2026-11-10: first audit, before 0.1.0

What the README promises, and the test that proves each:

| Promise | Test |
| --- | --- |
| Starts closed; closed and invite-only refuse with the site's message; the setting changes the mode at once | `modes > starts closed…` |
| The form can ask the mode | `modes > reports the mode` |
| Approval: verify, a disabled account, "waiting" only after the right password, approve activates, `onApprove`, "You're in" | `approval mode > verifies the email…` |
| Decline deletes the account, sends the note, and a repeat changes nothing | `approval mode > declines…` |
| A failed `onApprove` rolls everything back, with no email | `approval mode > rolls the approval back…` |
| Open mode activates on verifying, with one email; shutting sign-up in between leaves it waiting | `open mode` (2) |
| The same answer for an existing account (email to its owner), and for one already waiting (no email) | `no account enumeration` (2) |
| A repeat before verifying replaces the request, the password and the link | `no account enumeration > replaces…` |
| Check refusals shown, nothing stored; a broken check refuses; flags and user data carried; answers never stored | `refusals` (2) and `approval mode > verifies…` |
| Bad email, short password, missing required details, failed or broken human check: refused | `refusals > refuses a bad email…` |
| Expired, used and made-up links refused; opening the link verifies nothing; the button verifies | `refusals` (2), `builtin > the email link` |
| Rate limits: address and site refuse, email goes quiet, a broken limiter refuses | `rate limits` |
| The built-in limiter counts and stores only hashes | `builtin > the built-in rate limiter` |
| Staff decide only waiting requests and change nothing else; decided can't be changed | `staff and access > lets staff…` |
| The queue, settings and counts are closed to others; nobody can set `signupStatus` | `staff and access > keeps the queue…` |
| No signed-out account creation once there are users | `builtin > accounts only through sign-up` |
| Retention deletes the right requests and unconfirmed accounts, keeps waiting ones | `retention` |

Gaps skipped, and why:
- **`scopeField` with a real tenant plugin.** The first site's integration covers it on a real site; a fake tenant field here would test the fake.
- **Real email delivery.** It needs the site's email adapter; the first site tests it.
- **The very first user through the API** (allowed so a new site can start). Payload's own first-register flow, which needs no test here.
- **Timing differences** between "new address" and "existing account". Both do a few database calls and send one email. Not measured, so not claimed.

22 tests.

## 2026-11-10: 0.1.1, the confirm page shows the request

| Promise | Test |
| --- | --- |
| `readSignupRequest` gives the email and configured fields as words; it doesn't use up the link; check answers and check-set user data aren't shown | `the confirm page > reads the email and the details…` |
| Used, made-up, wrong-type and expired links read as `badLink`; reads count against the verify limit | `the confirm page > reads…` and `refuses an expired link…` |
| The page shows the request above the form, escaped; a dead link says so with no form; a refused limiter leaves the form without the summary | `the confirm page > shows the request…` |

| Only listed fields show; hidden and read-restricted fields never show, even when listed | `the confirm page > shows only the fields the site listed…` |
| A password retry keeps the summary; a mismatch counts against the verify limit; a short password doesn't count twice | `the confirm page > keeps the summary on a password retry…` |
| The email and labels are escaped (an address written straight to the database) | `the confirm page > shows the request…` |

Gaps added: the five tests above, after the security read's mutation check found the hidden-field skip and two escapes untested. A second mutation check catches all six guards. Gaps skipped: dropping `status: unverified` from the read's query isn't caught, because used links lose their token hash anyway; the condition is kept as a backup.
