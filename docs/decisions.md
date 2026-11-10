# Decisions

Dated decisions for this repo, newest last.

- 2026-11-10: created from the ops starter kit, area `captive-origins`.
- 2026-11-10 (owner, relayed verbatim by Helm, about 5:10 PM MST): "Thoughts on changing invite only to requesting an account? Then they could provide the required info we need (in the format we need), but it creates a disabled account. We can then okay whoever we want in until Friday, at which time we turn off the request account thing. Request account feature + guardianship account stuff should both be their own plugins id imagine". He chose "Yes, as a plugin now" and, for retention, "90 days".
- 2026-11-10 (owner, relayed by Platform, about 6:15 PM MST): "Don't worry about the days, just about doing it right". Monday 11-16 and Friday 11-20 are targets; anything not right by the Sunday freeze slips.
- 2026-11-10: named Sign-up (`payload-plugin-signup`) rather than Access Requests, because it runs all four modes, not only requests. Helm can change it before the first publish if the owner prefers the other.
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
- 2026-11-10 (with Platform): the age gate is its own plugin (Platform builds it). Sign-up only runs the checks it's given, and passes check-only `answers` that are never stored.
