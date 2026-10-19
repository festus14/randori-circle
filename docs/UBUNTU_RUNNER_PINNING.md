# Ubuntu runner pinning and Ubuntu 26 canary

Status: implemented for issue #238. CI configuration only; the application and
providers are unchanged.

## Decision

GitHub starts moving `ubuntu-latest` to Ubuntu 26 on 2026-10-19. Randori depends
on native SQLite/libSQL behavior, Node 24, the system packages Playwright
Chromium needs, and timing-sensitive tests. Letting the image change on its own
schedule could break protected releases or hide a real compatibility change.

Every workflow job now runs on `ubuntu-24.04`, the image all current evidence
was collected on. The only exception is the non-required
`ubuntu-26-canary` job, which runs on `ubuntu-26.04`.
`tests/unit/github-actions-runtime.test.mjs` parses every workflow and fails if
any file contains `ubuntu-latest` or if any job uses a runner other than the
reviewed one. The test runs inside `npm run test:coverage`, which the required
`e2e` check executes.

Only `runs-on` changed. Triggers, permissions, protected environments, secret
placement, concurrency locks, commands, and timeouts are the same as before.
The digests that pin exact workflow bytes in `scripts/check-deployability.mjs`
and `scripts/check-backup-controls.mjs` were updated to match the new bytes.

## Inventory

| Workflow | Class | Runner |
|---|---|---|
| `deployability.yml` | Required release check (`deployability`) | `ubuntu-24.04` |
| `e2e.yml` | Required release check (`e2e`) | `ubuntu-24.04` |
| `outbox-dispatch.yml` | Scheduler, production secret | `ubuntu-24.04` |
| `outbox-dispatch-watchdog.yml` | Watchdog, read-only | `ubuntu-24.04` |
| `turso-backup-restore-rehearsal.yml` | Scheduled rehearsal, protected environment | `ubuntu-24.04` |
| `turso-backup-restore-watchdog.yml` | Watchdog, read-only | `ubuntu-24.04` |
| `turso-production-migration.yml` | Manual production operation | `ubuntu-24.04` |
| `credential-key-control.yml` | Manual production operation | `ubuntu-24.04` |
| `chat-retention.yml` | Manual protected operation | `ubuntu-24.04` |
| `ubuntu-26-canary.yml` | Optional compatibility canary | `ubuntu-26.04` |

## Canary

`ubuntu-26-canary.yml` runs on pull requests to `main`, every Monday at 06:23
UTC, and on manual dispatch. Its permissions are `contents: read`, and it has no
secrets, no environment, no production calls, and no cron dispatch. It repeats
the `e2e` gate (dependency install, production audit, catalogue validation,
runtime-DDL, syntax, migrations, coverage, Chromium) and first logs the OS
release, kernel, Node/npm, ICU/OpenSSL, timezone/locale, libSQL's SQLite
version, glibc, and font count. You can compare that log line by line with an
`ubuntu-24.04` run.

The canary runs in parallel with the required checks and is not in branch
protection, so the time to merge does not grow.

## Rollout

1. Now: required checks and operations stay on `ubuntu-24.04`. The canary
   collects Ubuntu 26 evidence.
2. Look into every canary failure. If it is a real incompatibility (SQLite/libSQL,
   Node, browser, fonts/timezone, system libraries), fix it in the repository
   or record it here.
3. Promote only after repeated green evidence: at least four consecutive green
   scheduled runs, plus green results on the pull requests merged in that
   window. A separate reviewed change then moves the jobs to `ubuntu-26.04`,
   updates the pinned digests and the runner guard, and retires the canary or
   points it at the next image.
4. Do not stay on the old pin indefinitely. Schedule the removal well before
   GitHub retires the `ubuntu-24.04` label.

## Ownership, evidence, rollback

- Owner: the repository maintainer (festus14) owns the canary results and the
  promotion decision.
- Evidence: canary run logs and the `ubuntu-26-canary-report-*` artifacts,
  which are kept for 7 days. Link the green run IDs in the promotion PR.
- Rollback: if a promoted image regresses, revert the promotion PR. That
  restores the `ubuntu-24.04` pin, the matching digests, and the guard. If
  the canary is noisy, disable the workflow in the Actions UI; the required
  checks are not affected.
