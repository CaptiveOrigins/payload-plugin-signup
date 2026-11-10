# Changelog

## 0.1.0 (unreleased)

First version: four modes (open, approval, invite-only, closed) switched in the admin; requests with your own fields, checks and check-only answers; email confirmation where the person chooses their password, so the account is made only by the address's owner; a disabled account until approved; `access.manage` required; staff decide in the admin, singly or in bulk; the same answer for every address; rate limits (yours, or a built-in one with hashed keys); no signed-out account creation once a site has users; 90-day retention.

Tested: 28 integration tests on a real MongoDB in memory, and an independent security read (its two required fixes are in). Not tested: a real site, real email, a tenant plugin with `scopeField`.
