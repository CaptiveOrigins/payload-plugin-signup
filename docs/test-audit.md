# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md`, "Test self-audits". Newest first.

## 2026-11-10: second audit, after the security read

Plugin Security's two required fixes changed the flow (the password is chosen when confirming; `access.manage` is required). Tests rewritten to match, and these added:

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
- **`scopeField` with a real tenant plugin.** Platform's integration covers it on a real site; a fake tenant field here would test the fake.
- **Real email delivery.** It needs the site's email adapter; Platform tests it.
- **The very first user through the API** (allowed so a new site can start). Payload's own first-register flow, which needs no test here.
- **Timing differences** between "new address" and "existing account". Both do a few database calls and send one email. Not measured, so not claimed.

22 tests.

## 2026-11-10: 0.1.1, the confirm page shows the request (K3)

| Promise | Test |
| --- | --- |
| `readSignupRequest` gives the email and configured fields as words; it doesn't use up the link; check answers and check-set user data aren't shown | `the confirm page > reads the email and the details…` |
| Used, made-up, wrong-type and expired links read as `badLink`; reads count against the verify limit | `the confirm page > reads…` and `refuses an expired link…` |
| The page shows the request above the form, escaped; a dead link says so with no form; a refused limiter leaves the form without the summary | `the confirm page > shows the request…` |

Gaps added: the three tests above. Gaps skipped: none new.
