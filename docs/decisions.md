# Decisions

Dated decisions for this repo, newest last.

- 2026-11-10: created from the standard repo starter kit.
- 2026-11-10 (owner): change invite-only to requesting an account. People give the details the site needs, in its format, and get a disabled account. Staff approve whoever they want until Friday, when requests are turned off. Account requests and guardianship should each be their own plugin. He chose "Yes, as a plugin now" and, for retention, "90 days".
- 2026-11-10 (owner): doing it right matters more than the dates. Monday 11-16 and Friday 11-20 are targets; anything not right by the Sunday freeze slips.
- 2026-11-10: named Sign-up (`payload-plugin-signup`) rather than Access Requests, because it runs all four modes, not only requests. The owner confirmed it the same day. He also agreed the design calls below.
- 2026-11-10: design calls.
  - People choose their password at sign-up. The account exists from verification, disabled, and only active accounts sign in.
  - "Waiting for approval" is said only after the password matched (Payload runs beforeLogin after the password check).
  - Staff decide by changing Status in Payload's own edit and bulk-edit screens. These are accessible already, and need no custom admin code.
  - Declining deletes the account.
  - A decline stands for its retention time: asking again in that time changes nothing.
  - A repeat request before verifying replaces the earlier one, so nobody can hold an address by asking first.
  - Approved requests are deleted after 90 days too, since the account is then the record.
  - The email link shows a button instead of verifying on open, because mail scanners open links.
  - Once a site has users, signed-out API account creation is refused.
- 2026-11-10 (with the first site): the age gate is its own plugin, built separately. Sign-up only runs the checks it's given, and passes check-only `answers` that are never stored.
- 2026-11-10 (owner), a standing rule: plugins are agnostic and independent of each other, and work well together. Always build with the best architecture first, never just the fastest. Sign-up follows it: the age gate is a separate plugin, plugged in through `checks`.
- 2026-11-10 (independent security read), two required fixes, both done:
  - **Who manages sign-up:** the default was any signed-in user, so any member (a child included) could read the queue, decide requests and open sign-up. Now `access.manage` is required, and the plugin won't start without it. `signupStatus` is readable only by the account and by managers, and checks' `userData` is never shown in the queue.
  - **Setting up an account under someone else's address:** the password used to be chosen when asking, so whoever asked with a parent's address got the account once the parent pressed Confirm. Now nothing is made when asking. The person with the inbox chooses the password on the confirm page, and the account is made then. This replaces "people choose their password at sign-up" above. Unconfirmed requests no longer have accounts, so there's no `unverified` account status.
  - Also taken from its recommendations:
    - the same lookups in every case, against timing;
    - requests with no address count under "unknown";
    - the README notes the spoofable `x-forwarded-for` default and the cheap site-wide block, and suggests `verifyHuman` on public sites.

## 2026-11-10: standing rules from the owner

- Build it right: agnostic plugins with optional adapters, best architecture first. This repo imports no other plugin from this set.
- This repo is public, with limits on CI minutes.
- The name "Sign-up" is approved (2026-11-10).
- No plugin-family tags yet. None are in `package.json` keywords.

## 2026-11-10: 0.1.1, show the request on the confirm page

- Asked for in the first site's review: people should see what they're confirming. `readSignupRequest` only reads, so mail scanners opening the link stay harmless, and a dead link is reported before the password form.
- It shows only the fields a site lists in `confirmShows`, none by default, and never hidden fields, fields with read access, `userData` or check answers. The security read on c533927 (a subagent, using the plugin security checklist) found the first version showed every field. A child who mistypes their address would have shown their details to the owner of that inbox. Kids first, so it's opt-in. The first site should list `name` at most.
- It's on the `confirm-details` branch, not main, because the owner's publish of main is 0.1.0, the code the security read approved (8feec5d). 0.1.1 merges and goes through the staged Release workflow after 0.1.0 is on npm, with a pre-publish security read first.
- 2026-11-10: checks can run again at confirm through a separate, optional `confirmChecks`, not by re-running `checks`: check-only answers are never stored, so the request-time checks couldn't see them again. A refusal at confirm declines the request (committed before the person is told); a check that throws refuses for now and leaves the request and its link as they were.
- 2026-11-10 (security read, approved at 9bb0dfd): two edge cases are accepted and fail safe. Without transactions (no replica set), two confirms at the same moment with a check that answers differently could let the second overwrite the first's decline; and inside a caller's own transaction the decline commits only when the caller commits. Neither makes an account past a refusal. Site checks at asking now log only the error's name, as confirm checks do, so a check's error text (which could carry an answer) never reaches logs.

## 2026-11-11: which address the rate limits count (security read on d2e758a)

- The default `clientAddress` is `x-real-ip` when present, then the **last** `x-forwarded-for` entry. It used to be the first entry.
- Why the last: a proxy that appends to `x-forwarded-for` adds the address it saw at the end. Everything before that came from the visitor's own request and can say anything, so counting by the first entry let one person make a fresh rate-limit count per request. Behind exactly one trusted proxy, the last entry is the only one that proxy vouches for. With more proxies, the right entry is further left, and only the site knows how many there are, so those sites pass `clientAddress`.
- Why `x-real-ip` first: hosts like Vercel set it themselves and overwrite what the visitor sent. Where nothing sets it (no proxy), a visitor can send it, as they can `x-forwarded-for`; the README says to pass `clientAddress` there.
- Also from the same read: a cookie from a check must be printable ASCII, checked before anything is stored or emailed; checks can't add headers through `req.responseHeaders`; and the slower of two confirms of one link gets `badLink`, not a 500.
- 2026-11-13: moved to the ExtantApe GitHub organization and the `@extantape` npm scope at the same version. EXTANT APE owns its reusable tools and licenses them to the platform. The earlier package name is deprecated with a pointer here, and GitHub redirects the old repository address.
