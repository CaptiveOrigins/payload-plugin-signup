# Changelog

## 0.1.1 (unreleased)

- The confirm page shows what was asked for before the password form: "You asked for an account as <email>", then each of your fields with its label and value. A dead link now says so straight away, not after someone has typed a password twice.
- `readSignupRequest(payload, { token }, req)` gives a site's own confirm page the same: `{ email, details: [{ name, label, value }] }`. It only reads, so the link still works. It shows only your configured fields. Check-only answers were never stored, and what checks set for the account isn't shown. A used, expired or made-up link gets `badLink`, and reads count against the `verify` rate limit.

Tested: 3 new integration tests (31 in all). Not tested: a real site or real email.

## 0.1.0 (unreleased)

First version: four modes (open, approval, invite-only, closed) switched in the admin; requests with your own fields, checks and check-only answers; email confirmation where the person chooses their password, so the account is made only by the address's owner; a disabled account until approved; `access.manage` required; staff decide in the admin, singly or in bulk; the same answer for every address; rate limits (yours, or a built-in one with hashed keys); no signed-out account creation once a site has users; 90-day retention.

Tested: 28 integration tests on a real MongoDB in memory, and an independent security read (its two required fixes are in). Not tested: a real site, real email, a tenant plugin with `scopeField`.
