# Changelog

## Unreleased

Fixed: `POST /api/signup/request` handed checks and the rate limiter a copy of the request without its headers, so a check that read them (Age Gate's) refused everyone with 503 `checkFailed`, and every visitor shared one "unknown" rate-limit count, which one person could use up for the whole site. Checks, limits, the human check and emails now get the request itself, and `verifySignup` too. Checks are typed to take the full `PayloadRequest` (checks that take less still fit). New: a check may return `setCookies`, which the endpoint sets on its response, refusals included, and `submitSignup` hands back for a site's own form. Tested with a real Payload and MongoDB in memory; not on a real site.

## 0.1.0 (unreleased)

First version: four modes (open, approval, invite-only, closed) switched in the admin; requests with your own fields, checks and check-only answers; email confirmation where the person chooses their password, so the account is made only by the address's owner; a disabled account until approved; `access.manage` required; staff decide in the admin, singly or in bulk; the same answer for every address; rate limits (yours, or a built-in one with hashed keys); no signed-out account creation once a site has users; 90-day retention.

Tested: 28 integration tests on a real MongoDB in memory, and an independent security read (its two required fixes are in). Not tested: a real site, real email, a tenant plugin with `scopeField`.
