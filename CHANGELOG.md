# Changelog

## 0.1.0 (unreleased)

First version: four modes (open, approval, invite-only, closed) switched in the admin; requests with your own fields, checks and check-only answers; email verification with a confirm button; a disabled account until approved; staff decide in the admin, singly or in bulk; the same answer for every address; rate limits (yours, or a built-in one with hashed keys); no signed-out account creation once a site has users; 90-day retention.

Tested: 22 integration tests on a real MongoDB in memory. Not tested: a real site, real email, a tenant plugin with `scopeField`.
