# First public push audit

By the Kitting Plugin session (Sign-up lead), 2026-11-10, before the repo's first push. The owner's rule: "No private repos because CI" (2026-11-10).

Every commit was scanned, not just the latest files.

| Check | Result |
| --- | --- |
| `scripts/leak-check.sh` locally, with the private terms list | passed |
| Keys, tokens, passwords, secrets | none. The tests use made-up passwords and the secret `test-secret-not-for-production` |
| Email addresses in history | only made-up `@example.com` addresses in tests and the noreply author address |
| IP addresses | only documentation ranges in tests (`203.0.113.x`, `198.51.100.x`), reserved for examples |
| Server or database hosts, deploy URLs | none |
| Phone numbers, street addresses, real people's data | none |
| Home folder paths, personal names | none in files or commit messages. Git's author field holds the full name, which is allowed |
| Claude session links in commit text | none |
| Build output, `node_modules`, `.env`, `.secrets/` | never committed (ignored) |
| Leak check in CI | yes, `.github/workflows/leak-check.yml`, on every change |
| LICENSE | MIT, now "Copyright (c) 2026 EXTANT APE" |
| README status line | yes |

Result: clean. Nothing needed rewriting.
