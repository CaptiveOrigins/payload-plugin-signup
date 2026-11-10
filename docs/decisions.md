# Decisions

Dated decisions for this repo, newest last.

- 2026-11-10: created from the ops starter kit, area `captive-origins`.
- 2026-11-10 (owner, relayed verbatim by Helm, about 5:10 PM MST): "Thoughts on changing invite only to requesting an account? Then they could provide the required info we need (in the format we need), but it creates a disabled account. We can then okay whoever we want in until Friday, at which time we turn off the request account thing. Request account feature + guardianship account stuff should both be their own plugins id imagine". He chose "Yes, as a plugin now" and, for retention, "90 days".
- 2026-11-10 (owner, relayed by Platform, about 6:15 PM MST): "Don't worry about the days, just about doing it right". Monday 11-16 and Friday 11-20 are targets; anything not right by the Sunday freeze slips.
- 2026-11-10: named Sign-up (`payload-plugin-signup`) rather than Access Requests, because it runs all four modes, not only requests. The owner confirmed it (relayed verbatim by Helm, about 5:25 PM MST): "Sign-up (Recommended)". He also agreed the design calls below.
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
- 2026-11-10 (owner, relayed verbatim by Helm, about 5:35 PM MST), a standing rule: "they should be their own agnostic plugins that aren't dependent on each other but work seamlessly. That should basically be our motto" and "Always build it with the best architecture first, never just the fastest". Sign-up follows it: the age gate is a separate plugin, plugged in through `checks`.
- 2026-11-10 (Plugin Security's independent read, ledger 53c8805e1452), two required fixes, both done:
  - **Who manages sign-up:** the default was any signed-in user, so any member (a child included) could read the queue, decide requests and open sign-up. Now `access.manage` is required, and the plugin won't start without it. `signupStatus` is readable only by the account and by managers, and checks' `userData` is never shown in the queue.
  - **Setting up an account under someone else's address:** the password used to be chosen when asking, so whoever asked with a parent's address got the account once the parent pressed Confirm. Now nothing is made when asking. The person with the inbox chooses the password on the confirm page, and the account is made then. This replaces "people choose their password at sign-up" above. Unconfirmed requests no longer have accounts, so there's no `unverified` account status.
  - Also taken from its recommendations:
    - the same lookups in every case, against timing;
    - requests with no address count under "unknown";
    - the README notes the spoofable `x-forwarded-for` default and the cheap site-wide block, and suggests `verifyHuman` on public sites.

## 2026-11-10: decision feed acknowledged (ops/decisions/all.md, captive-origins.md)

Settled decisions from the owner, through Helm's feed. The feed holds the owner's exact words.

- **D1** Settled decisions arrive through the feed and are acted on, not re-argued.
- **D2** Build it right: agnostic plugins with optional adapters, best architecture first. This repo imports no other Captive Origins plugin.
- **D3** Owner steps and tests go to `~/Code/ops/inbox/` per `ops/rules/owner-items.md`, never straight to needs-you.md or tests.md.
- **D4** Priority: Docker media, Minecraft server, then all Captive Origins.
- **D5** No private repos to save CI minutes. This repo is public, with the Actions-minutes rules.
- **D6, D21** Plugin names need the owner's OK before work starts (ops/plugin-names.md). "Sign-up" is approved (2026-11-10).
- **D7** No launch dates: work follows the priority list in ops/timeline-captive-origins.md. A freeze point is cut only when the owner says so.
- **D8** Seed World hears about every collection-structure change ahead of time, with versions, and audits when it lands.
- **D12** No plugin-family tags yet. None are in `package.json` keywords.
- Not for this repo: D9 (PM doc), D10 (tour before studbook), D11 (kids decide on guardian suggestions), D14 (plan B), D15 (Husbandry.Pro link), D16 (both views).

## 2026-11-10: 0.1.1, show the request on the confirm page (K3)

- Asked for in the Site lead's review: people should see what they're confirming. `readSignupRequest` only reads, so mail scanners opening the link stay harmless, and a dead link is reported before the password form.
- It shows only the configured fields, never `userData` or check answers, because those can carry age details meant for checks and staff rules, not for display.
- It's on the `confirm-details` branch, not main, because the owner's N96 publishes main as 0.1.0, the code Plugin Security approved (8feec5d). 0.1.1 merges and goes through the staged Release workflow after 0.1.0 is on npm, with a pre-publish security read first (K34).
