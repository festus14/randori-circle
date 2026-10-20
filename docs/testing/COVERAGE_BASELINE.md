# Unit test coverage baseline

Measured 2026-10-19 on `main` (as of 5992fe0) (Node 24.15.0, 1135 unit tests, 114 test files)
with `npm run test:coverage:report`. Scope: `api/*.js`, `db/*.js`,
`scripts/*.mjs` (99 files). The owner's target is **80% lines, branches and
functions**; this document is the starting point for the test-writing packages
below. The CI gate (`npm run test:coverage`) is pinned to the current true
totals rounded down and will be ratcheted to 80 once the packages land.

## True totals

| Metric | Old (built-in, wrong) | True (c8 merge) | CI gate now | Target |
|---|---|---|---|---|
| Lines | 61.59% | **89.98%** (35532/39487) | 89 | 80 |
| Branches | 78.10% | **78.16%** (12658/16193) | 78 | 80 |
| Functions | 85.62% | **97.19%** (1839/1892) | 97 | 80 |

Lines and functions already exceed 80% in aggregate. **Branches are the real
gap**: about 297 more covered branches are needed for an aggregate 80%, and
59 of 99 files are below 80% on at least one metric (nearly all on branches).
Totals vary by ~0.02 points between runs because a few tests are
timing-dependent. Linux CI (ubuntu-24.04 and ubuntu-26 canary) matches the
local macOS numbers. The lines total fell from 90.16% to 89.98% during this
PR only because `scripts/ui-screenshots.mjs`, which no unit test loads, grew
with UI work. That is why the lines gate is 89.

## Why the old numbers were wrong (root cause)

`node --experimental-test-coverage` in Node 24 has a filtering bug in
`lib/internal/test_runner/coverage.js` (`shouldSkipFileCoverage`): when
`--test-coverage-include` globs are given, a matching file returns "keep"
*before* the check that drops module-mock URLs (`?node-test-mock=N`). Each
`mock.module('../../api/_outbox.js', ...)` creates a small synthetic module
whose URL is `file:///…/api/_outbox.js?node-test-mock=0`. That entry is kept,
`fileURLToPath` strips the query, and the summary maps the synthetic module's
ranges onto the real source file. The report is keyed by path, so the
synthetic entry replaced the real one in the per-file table, and the totals
counted the file twice (once real, once synthetic).

Evidence:

- The raw V8 entry for `api/_circle-pairing.js?node-test-mock=0` covers bytes
  0–816 with count 1; the real file is 35065 bytes. 816 bytes is about the first
  44 of 693 lines, which matches the bogus 6.35% lines. Its handful of
  synthetic functions all ran, which explains the 100% functions.
- Every file on the suspicious list (`_circle-pairing`, `_pairing-publication`,
  `_outbox`, `_availability`, `_member-lifecycle`, `_pairing-email`,
  `_pairing-readiness`, `_circle-archive`, `_schedule-email`, `_active-circle`,
  `_invitation-email`, `_circle-membership`, `_circle-creation`, `_db`) is
  exactly the set of `api/` modules that some test replaces with `mock.module`.
- A second, smaller distortion: `tests/unit/sentry-adapter.test.mjs` imports
  `../../api/_db.js?sentry-test=<case>` to get fresh module instances. Each
  query URL is a separate script that Node never merges with the plain URL.
- Running only `tests/unit/circle-pairing.test.mjs` +
  `tests/unit/api-behavior.test.mjs` (neither mocks `_circle-pairing.js`) with
  the built-in coverage reports 92.64% lines for `_circle-pairing.js`, the
  same as the new full-suite number.

| File | Old L / B / F | True L / B / F |
|---|---|---|
| `api/_circle-pairing.js` | 6.35 / 50.00 / 100.00 | 92.64 / 76.92 / 100 |
| `api/_outbox.js` | 6.91 / 50.00 / 100.00 | 92.45 / 72.91 / 95.23 |
| `api/_db.js` | 23.36 / 33.33 / 6.45 | 96.02 / 82.02 / 100 |

Spot checks (lcov `DA` hit counts) for lines the old report listed as
uncovered: `_outbox.js` 107–110 (`retryableConflict`) were hit 2–3 times;
`_circle-pairing.js` 23–40 were hit 16 times; `_db.js` 113–114 (`initSentry`
path) were hit 9 times and 141–142 were hit 187 times.

## How coverage is measured now

`tests/support/coverage.mjs` (used by `npm run test:coverage` and
`npm run test:coverage:report`):

1. Runs `node --experimental-test-module-mocks --test tests/unit/*.test.mjs`
   with `NODE_V8_COVERAGE` pointed at a temp dir, so every test process
   (including any child processes it spawns) writes raw V8 coverage.
2. Drops every script whose URL has a `node-test-mock` query, and folds other
   query-string imports (`_db.js?sentry-test=…`) back onto the plain file URL.
3. Runs `c8 report --all` on the cleaned data. c8 merges with
   `@bcoe/v8-coverage` and reports with istanbul. `--all` lists files no test
   loads as 0%, where before they were silently left out (5 scripts, see below).
4. Applies `--lines/--branches/--functions` thresholds with
   `c8 --check-coverage`.

Options: `--report` prints the per-file table; `--out=DIR` keeps
`coverage-summary.json`, `coverage-final.json` and `lcov.info` in DIR.

Ratchet: when a package lands, raise the thresholds in `package.json`
`test:coverage` to the new totals rounded down, then to 80/80/80.

## Excluded from scope

`tests/support/coverage.mjs` passes `EXCLUDE` to c8, so these files are not
in the totals. Both are operator tools that cannot run inside a unit test.
Their pass/fail logic was moved into sibling modules that are measured and
tested (`tests/unit/cov-p5-operator-tool-policy.test.mjs`).

| File | Reason | Tested sibling |
|---|---|---|
| `scripts/execution-smoke.mjs` | Opt-in live smoke against the real Vercel Sandbox API. It needs a `VERCEL_OIDC_TOKEN` and creates five billable sandboxes per run, so it never runs in `npm test` or CI. | `scripts/execution-smoke-checks.mjs`: refusing to run without credentials (exit 2), counting only explicit passes, the egress verdict (passes only on positive proof that egress is blocked), and failure message formatting. |
| `scripts/ui-screenshots.mjs` | Manual design-review tool. It drives Playwright Chromium against production and a local runtime and writes PNGs. It is not a test, and it runs only from the manual `ui-screenshots.yml` workflow. | `scripts/ui-screenshots-policy.mjs`: option parsing (scope, viewports, https-only origin) and the read-only request guard (only GET/HEAD/OPTIONS go through; blocked URLs are recorded without query or fragment). |

The main guard of `execution-smoke.mjs` now only runs when the file is
executed directly, so importing it has no side effects.

## Gap list (files below 80% on any metric, worst first)

"Lines with uncovered branches" are source lines that hold at least one branch with zero hits (the first 40 per file are listed).

- `scripts/execution-smoke.mjs` — L 0 / B 0 / F 0. Never loaded by any unit test.
- `scripts/generate-schema-readiness.mjs` — L 0 / B 0 / F 0. Never loaded by any unit test.
- `scripts/local-reset.mjs` — L 0 / B 0 / F 0. Never loaded by any unit test.
- `scripts/ui-screenshots.mjs` — L 0 / B 0 / F 0. Never loaded by any unit test.
- `scripts/validate-catalog.mjs` — L 0 / B 0 / F 0. Never loaded by any unit test.
- `db/migration-contract.js` — L 98.34 / B 33.33 / F 100. Uncovered branches: 6 (need +5 for 80%). Uncovered functions: none. Lines with uncovered branches: 106, 109, 112, 113, 114.
- `scripts/check-crdt-bundle.mjs` — L 84.37 / B 40 / F 100. Uncovered branches: 3 (need +2 for 80%). Uncovered functions: none. Lines with uncovered branches: 23, 29.
- `scripts/chat-retention.mjs` — L 40.49 / B 57.89 / F 57.14. Uncovered branches: 8 (need +5 for 80%). Uncovered functions: `positiveInteger@24`, `scopeFromEnvironment@37`, `gateFromEnvironment@49`. Lines with uncovered branches: 32, 33, 74, 78, 86, 91, 149.
- `db/migration-ledger.js` — L 95.55 / B 50 / F 100. Uncovered branches: 3 (need +2 for 80%). Uncovered functions: none. Lines with uncovered branches: 28, 38, 39.
- `db/executable-migrations.js` — L 80.39 / B 62.06 / F 100. Uncovered branches: 11 (need +6 for 80%). Uncovered functions: none. Lines with uncovered branches: 36, 42, 62, 65, 69, 72, 76, 80, 86, 92, 95.
- `api/_identity-linking.js` — L 89.88 / B 62.26 / F 100. Uncovered branches: 80 (need +38 for 80%). Uncovered functions: none. Lines with uncovered branches: 50, 75, 77, 78, 80, 83, 85, 97, 98, 101, 104, 111, 121, 126, 129, 134, 137, 157, 161, 162, 166, 167, 171, 175, 181, 184, 193, 198, 212, 219, 229, 233, 234, 250, 251, 256, 267, 269, 279, 280, ... (+36 more).
- `api/_code-document.js` — L 86.7 / B 62.67 / F 97.72. Uncovered branches: 106 (need +50 for 80%). Uncovered functions: `retryDelay@548`. Lines with uncovered branches: 28, 33, 37, 44, 57, 60, 61, 62, 63, 65, 72, 73, 77, 78, 79, 80, 89, 95, 106, 109, 116, 120, 123, 144, 146, 161, 192, 198, 199, 200, 203, 204, 209, 217, 223, 226, 229, 233, 244, 247, ... (+58 more).
- `api/_password-reset.js` — L 92.78 / B 63.19 / F 96.15. Uncovered branches: 53 (need +25 for 80%). Uncovered functions: `passwordResetStatus@396`. Lines with uncovered branches: 36, 37, 66, 68, 69, 70, 77, 79, 91, 97, 106, 119, 120, 141, 146, 162, 205, 222, 231, 234, 241, 243, 251, 266, 269, 271, 277, 284, 287, 291, 304, 312, 316, 319, 322, 323, 337, 342, 344, 365, ... (+7 more).
- `api/_chat-retention.js` — L 93.65 / B 63.4 / F 95. Uncovered branches: 101 (need +46 for 80%). Uncovered functions: `retryDelay@137`, `chatRetentionRuntimeConfig@221`. Lines with uncovered branches: 21, 29, 30, 35, 40, 41, 46, 47, 54, 61, 62, 63, 64, 79, 80, 86, 87, 90, 98, 106, 111, 114, 116, 117, 128, 129, 152, 153, 155, 157, 167, 168, 230, 231, 232, 261, 270, 272, 281, 307, ... (+45 more).
- `scripts/credential-key-control.mjs` — L 78.82 / B 63.75 / F 84.61. Uncovered branches: 29 (need +13 for 80%). Uncovered functions: `parseArgv@139`, `main@199`. Lines with uncovered branches: 43, 52, 53, 55, 62, 63, 64, 67, 69, 72, 76, 94, 161, 162, 163, 165, 184, 186, 187, 188, 189, 190, 191, 192, 196, 215.
- `api/_circle-membership.js` — L 94.93 / B 64.24 / F 94.73. Uncovered branches: 59 (need +26 for 80%). Uncovered functions: `clearInviteClaimCookie@156`, `hasActiveCircleMembership@206`. Lines with uncovered branches: 23, 25, 34, 40, 49, 50, 54, 58, 62, 63, 68, 84, 86, 94, 96, 97, 99, 106, 107, 110, 141, 142, 143, 147, 148, 166, 188, 221, 228, 232, 241, 247, 253, 268, 281, 296, 318, 325, 378, 379, ... (+19 more).
- `api/_invitation-email.js` — L 94.79 / B 68.21 / F 100. Uncovered branches: 41 (need +16 for 80%). Uncovered functions: none. Lines with uncovered branches: 35, 37, 39, 40, 68, 71, 73, 81, 82, 87, 89, 98, 99, 105, 109, 110, 112, 125, 134, 161, 164, 165, 169, 174, 190, 193, 240, 243, 246, 251, 268, 269, 278, 279, 280, 286, 322, 323, 329, 340.
- `api/invitations.js` — L 91.31 / B 68.37 / F 100. Uncovered branches: 80 (need +30 for 80%). Uncovered functions: none. Lines with uncovered branches: 54, 57, 58, 59, 66, 67, 72, 73, 74, 79, 80, 93, 98, 99, 103, 108, 109, 110, 111, 115, 116, 146, 153, 154, 160, 168, 187, 190, 207, 208, 209, 214, 222, 260, 262, 276, 299, 317, 326, 346, ... (+37 more).
- `api/_secondary-schedule-email.js` — L 83.07 / B 69.04 / F 93.33. Uncovered branches: 52 (need +19 for 80%). Uncovered functions: `providerError@352`. Lines with uncovered branches: 19, 24, 28, 36, 69, 72, 79, 86, 94, 95, 102, 104, 116, 120, 127, 128, 132, 133, 139, 140, 151, 179, 250, 256, 259, 260, 273, 275, 278, 280, 288, 289, 292, 295, 298, 299, 301, 308, 309, 324, ... (+8 more).
- `api/_email-activation.js` — L 94.54 / B 69.23 / F 96.15. Uncovered branches: 52 (need +19 for 80%). Uncovered functions: `emailActivationStatus@507`. Lines with uncovered branches: 36, 37, 43, 45, 46, 48, 78, 80, 81, 82, 90, 92, 104, 110, 119, 130, 165, 166, 167, 175, 180, 185, 262, 269, 309, 316, 318, 348, 366, 378, 388, 396, 402, 409, 415, 419, 422, 425, 426, 430, ... (+11 more).
- `api/code-document.js` — L 85.54 / B 70.45 / F 100. Uncovered branches: 13 (need +5 for 80%). Uncovered functions: none. Lines with uncovered branches: 19, 25, 28, 30, 35, 37, 46, 50, 65, 68, 79, 80.
- `api/_pairing-publication.js` — L 91.7 / B 70.54 / F 100. Uncovered branches: 81 (need +26 for 80%). Uncovered functions: none. Lines with uncovered branches: 32, 42, 47, 50, 54, 56, 57, 63, 65, 67, 69, 70, 72, 77, 85, 86, 91, 95, 96, 99, 103, 107, 112, 113, 125, 128, 168, 176, 177, 182, 191, 192, 193, 201, 205, 208, 212, 217, 219, 222, ... (+35 more).
- `db/backup-evidence.js` — L 91.22 / B 70.71 / F 100. Uncovered branches: 94 (need +30 for 80%). Uncovered functions: none. Lines with uncovered branches: 50, 65, 75, 85, 92, 94, 102, 105, 106, 113, 120, 157, 169, 174, 179, 186, 189, 193, 194, 195, 197, 203, 210, 211, 222, 224, 227, 232, 242, 244, 271, 273, 315, 316, 329, 336, 343, 346, 389, 390, ... (+50 more).
- `api/_admin-init.js` — L 90.3 / B 71.42 / F 100. Uncovered branches: 26 (need +8 for 80%). Uncovered functions: none. Lines with uncovered branches: 21, 22, 26, 27, 31, 35, 39, 61, 73, 88, 110, 115, 120, 125, 129, 130, 139, 145, 156, 157, 174, 183, 191, 195, 213.
- `api/_secondary-schedule.js` — L 90.76 / B 71.42 / F 96. Uncovered branches: 56 (need +17 for 80%). Uncovered functions: `retryDelay@395`. Lines with uncovered branches: 66, 70, 82, 89, 97, 102, 149, 154, 160, 167, 171, 178, 185, 196, 210, 246, 250, 251, 254, 259, 263, 294, 295, 296, 298, 304, 323, 324, 333, 338, 343, 351, 354, 359, 363, 367, 389, 406, 418, 419, ... (+15 more).
- `api/_active-circle.js` — L 96 / B 71.55 / F 100. Uncovered branches: 33 (need +10 for 80%). Uncovered functions: none. Lines with uncovered branches: 40, 41, 46, 47, 51, 53, 54, 58, 60, 78, 116, 117, 118, 130, 154, 155, 157, 158, 160, 177, 178, 185, 193, 220, 222, 258, 269, 272, 275, 280, 289, 294, 312.
- `scripts/local-server.mjs` — L 86.56 / B 71.88 / F 85.93. Uncovered branches: 106 (need +31 for 80%). Uncovered functions: `readLockOwner@265`, `processIsRunning@284`, `log@949`, `error@950`, `notReadyHandler@1100`, `failure@1138`, `restoreSqlObserver@1145`, `restoreEnvironment@1147`, `stop@1220`. Lines with uncovered branches: 105, 107, 109, 127, 134, 144, 151, 161, 165, 182, 206, 210, 215, 223, 229, 237, 243, 252, 259, 261, 301, 305, 314, 320, 328, 363, 372, 389, 397, 401, 405, 407, 420, 425, 427, 435, 446, 447, 466, 485, ... (+64 more).
- `api/_meeting-link.js` — L 90.8 / B 72.05 / F 95. Uncovered branches: 38 (need +11 for 80%). Uncovered functions: `MeetingLinkDataError@21`. Lines with uncovered branches: 34, 46, 47, 54, 59, 63, 70, 74, 81, 94, 103, 107, 113, 127, 129, 136, 140, 154, 160, 180, 186, 202, 215, 216, 235, 249, 250, 269, 279, 283, 328, 332, 336, 341, 343, 347, 358.
- `db/credential-key-control.js` — L 97.91 / B 72.09 / F 100. Uncovered branches: 12 (need +4 for 80%). Uncovered functions: none. Lines with uncovered branches: 30, 34, 35, 39, 47, 48, 53, 56, 63, 65, 71, 75.
- `api/ai.js` — L 91.64 / B 72.22 / F 100. Uncovered branches: 130 (need +37 for 80%). Uncovered functions: none. Lines with uncovered branches: 13, 20, 21, 31, 34, 35, 36, 37, 38, 40, 45, 46, 48, 51, 53, 54, 55, 57, 58, 60, 64, 66, 71, 112, 130, 132, 133, 138, 140, 142, 156, 157, 158, 159, 167, 171, 180, 181, 191, 196, ... (+79 more).
- `api/_availability.js` — L 89.86 / B 72.25 / F 100. Uncovered branches: 91 (need +26 for 80%). Uncovered functions: none. Lines with uncovered branches: 42, 52, 57, 60, 71, 79, 86, 87, 95, 104, 106, 113, 117, 118, 119, 120, 121, 122, 133, 140, 145, 150, 153, 178, 225, 226, 228, 229, 246, 248, 249, 256, 258, 285, 288, 301, 310, 322, 333, 346, ... (+42 more).
- `api/_outbox.js` — L 92.45 / B 72.91 / F 95.23. Uncovered branches: 94 (need +25 for 80%). Uncovered functions: `OutboxLeaseLostError@39`, `retryDelay@121`, `deadlineFailure@845`. Lines with uncovered branches: 48, 52, 53, 57, 58, 68, 74, 75, 84, 89, 97, 112, 113, 126, 127, 139, 142, 158, 161, 163, 164, 168, 169, 175, 180, 181, 198, 244, 245, 246, 248, 250, 252, 258, 270, 271, 298, 340, 349, 352, ... (+50 more).
- `scripts/turso-backup-restore-monitor.mjs` — L 93.97 / B 73.46 / F 100. Uncovered branches: 26 (need +7 for 80%). Uncovered functions: none. Lines with uncovered branches: 23, 32, 37, 38, 39, 49, 88, 89, 100, 107, 109, 120, 148, 171, 175, 182, 188, 195, 198, 208, 213, 263, 268, 271, 279.
- `api/_catalog-provenance.js` — L 87.79 / B 73.94 / F 95. Uncovered branches: 37 (need +9 for 80%). Uncovered functions: `requireNullableText@71`. Lines with uncovered branches: 47, 49, 53, 60, 63, 68, 76, 80, 88, 94, 106, 129, 165, 187, 190, 193, 203, 213, 216, 226, 228, 246, 248, 251, 255, 261, 266, 274, 277, 283, 295, 298, 312, 317, 320, 321, 327.
- `api/_circle-archive.js` — L 93.26 / B 74.28 / F 100. Uncovered branches: 27 (need +6 for 80%). Uncovered functions: none. Lines with uncovered branches: 29, 31, 33, 34, 59, 61, 76, 77, 79, 114, 127, 135, 136, 137, 142, 143, 152, 203, 213, 236, 238, 245, 252, 260, 270, 281.
- `api/_pairing-email.js` — L 90.8 / B 74.35 / F 93.75. Uncovered branches: 50 (need +11 for 80%). Uncovered functions: `deliverPairingEmails@444`. Lines with uncovered branches: 18, 31, 42, 47, 48, 50, 61, 69, 70, 73, 85, 90, 91, 120, 121, 122, 123, 128, 226, 239, 253, 254, 259, 274, 286, 294, 304, 308, 312, 315, 318, 333, 335, 336, 338, 340, 351, 352, 354, 357, ... (+6 more).
- `scripts/check-deployability.mjs` — L 91.81 / B 74.82 / F 100. Uncovered branches: 36 (need +8 for 80%). Uncovered functions: none. Lines with uncovered branches: 33, 42, 46, 81, 103, 111, 115, 117, 118, 123, 131, 139, 224, 263, 265, 268, 274, 293, 298, 324, 328, 347, 353, 357, 361, 379, 388, 400, 405, 411, 417, 423, 429, 439, 451.
- `api/_outbox-immediate.js` — L 95 / B 75 / F 100. Uncovered branches: 8 (need +2 for 80%). Uncovered functions: none. Lines with uncovered branches: 39, 43, 62, 64, 68, 90, 92, 97.
- `db/membership-readiness.js` — L 97.99 / B 75.71 / F 100. Uncovered branches: 17 (need +3 for 80%). Uncovered functions: none. Lines with uncovered branches: 3, 10, 13, 20, 23, 141, 155, 166, 169, 171, 179, 182, 185, 275, 284, 291, 294.
- `scripts/catalog-provenance.mjs` — L 89.28 / B 75.78 / F 90.47. Uncovered branches: 31 (need +6 for 80%). Uncovered functions: `takedownCommand@427`, `main@437`. Lines with uncovered branches: 24, 35, 37, 46, 47, 53, 69, 119, 151, 162, 172, 185, 188, 197, 221, 222, 231, 235, 265, 268, 274, 285, 294, 301, 308, 311, 419, 443.
- `scripts/production-smoke.mjs` — L 95.03 / B 76.06 / F 100. Uncovered branches: 28 (need +5 for 80%). Uncovered functions: none. Lines with uncovered branches: 58, 71, 72, 78, 79, 109, 115, 123, 124, 125, 143, 146, 155, 168, 176, 177, 179, 207, 218, 227, 240, 248, 256, 257.
- `api/_member-lifecycle.js` — L 94.2 / B 76.19 / F 100. Uncovered branches: 45 (need +8 for 80%). Uncovered functions: none. Lines with uncovered branches: 59, 64, 65, 66, 69, 70, 73, 74, 79, 80, 83, 90, 107, 109, 110, 118, 121, 126, 132, 154, 156, 187, 196, 208, 209, 213, 215, 221, 232, 233, 250, 298, 313, 337, 342, 378, 391, 409, 419, 425, ... (+3 more).
- `api/_session-controls.js` — L 92.84 / B 76.21 / F 100. Uncovered branches: 44 (need +7 for 80%). Uncovered functions: none. Lines with uncovered branches: 22, 35, 39, 51, 52, 59, 64, 68, 75, 79, 86, 93, 102, 116, 118, 131, 133, 146, 149, 154, 158, 163, 181, 196, 236, 237, 242, 261, 274, 291, 293, 315, 328, 332, 335, 382, 399, 411, 415, 417, ... (+2 more).
- `api/_session-completion.js` — L 90.97 / B 76.87 / F 100. Uncovered branches: 37 (need +5 for 80%). Uncovered functions: none. Lines with uncovered branches: 20, 36, 40, 52, 53, 60, 80, 99, 109, 116, 118, 125, 130, 142, 143, 147, 154, 157, 160, 170, 182, 201, 211, 220, 247, 250, 255, 274, 286, 288, 314, 358, 364, 371, 375, 387.
- `api/_circle-pairing.js` — L 92.64 / B 76.92 / F 100. Uncovered branches: 66 (need +9 for 80%). Uncovered functions: none. Lines with uncovered branches: 69, 80, 95, 109, 114, 117, 123, 134, 135, 148, 155, 165, 178, 192, 193, 198, 199, 215, 217, 234, 237, 239, 268, 269, 313, 314, 316, 321, 325, 326, 337, 359, 386, 392, 416, 443, 492, 526, 530, 539, ... (+20 more).
- `api/ops.js` — L 91.36 / B 76.94 / F 100. Uncovered branches: 139 (need +19 for 80%). Uncovered functions: none. Lines with uncovered branches: 75, 84, 85, 92, 108, 113, 116, 117, 118, 119, 124, 128, 138, 144, 150, 159, 160, 161, 165, 177, 178, 179, 180, 184, 194, 195, 196, 205, 215, 230, 256, 276, 277, 278, 279, 283, 290, 292, 313, 323, ... (+89 more).
- `api/_key-rotation.js` — L 89.31 / B 77.71 / F 94.44. Uncovered branches: 39 (need +4 for 80%). Uncovered functions: `assertCredentialEnvelopeKey@293`. Lines with uncovered branches: 37, 41, 44, 63, 66, 68, 76, 86, 89, 98, 102, 129, 134, 149, 175, 179, 181, 185, 207, 208, 223, 225, 230, 231, 243, 244, 249, 254, 278, 282, 288, 311, 315, 325, 353, 354, 364.
- `api/_circle-creation.js` — L 91.61 / B 78.16 / F 93.75. Uncovered branches: 31 (need +3 for 80%). Uncovered functions: `ensureCircleCreationReadiness@80`. Lines with uncovered branches: 51, 53, 55, 56, 66, 67, 69, 105, 107, 115, 116, 117, 118, 119, 125, 140, 176, 185, 189, 214, 231, 233, 244, 246, 254, 261, 271, 287, 297, 305, 317.
- `scripts/turso-backup-restore-rehearsal.mjs` — L 91.41 / B 78.19 / F 96.55. Uncovered branches: 116 (need +10 for 80%). Uncovered functions: `batch@560`, `recoveryWriter@1616`, `interrupt@1648`. Lines with uncovered branches: 47, 48, 49, 90, 98, 111, 119, 126, 134, 135, 143, 149, 152, 153, 165, 167, 176, 187, 193, 210, 211, 219, 250, 263, 267, 272, 280, 286, 379, 451, 454, 476, 494, 496, 505, 519, 567, 588, 593, 594, ... (+73 more).
- `api/auth.js` — L 91.27 / B 78.41 / F 100. Uncovered branches: 180 (need +14 for 80%). Uncovered functions: none. Lines with uncovered branches: 96, 103, 104, 122, 123, 146, 163, 164, 183, 189, 218, 225, 245, 264, 265, 302, 304, 306, 326, 328, 334, 335, 337, 338, 347, 351, 353, 359, 373, 389, 402, 404, 414, 426, 428, 436, 445, 454, 461, 473, ... (+135 more).
- `api/_outbox-delivery.js` — L 86.48 / B 78.57 / F 80. Uncovered branches: 6 (need +1 for 80%). Uncovered functions: `localCaptureSender@52`. Lines with uncovered branches: 41, 42, 43, 46, 84.
- `scripts/github-backup-restore-watchdog.mjs` — L 94.63 / B 78.75 / F 100. Uncovered branches: 41 (need +3 for 80%). Uncovered functions: none. Lines with uncovered branches: 30, 38, 43, 48, 49, 50, 59, 98, 115, 116, 157, 158, 164, 201, 203, 208, 271, 275, 290, 295, 296, 297, 298, 300, 316, 327, 331, 334, 341, 347, 352, 356, 365, 381, 382, 383, 405, 414, 420, 422, ... (+1 more).
- `api/_credential-key-control.js` — L 91.86 / B 79 / F 100. Uncovered branches: 21 (need +1 for 80%). Uncovered functions: none. Lines with uncovered branches: 12, 23, 25, 29, 36, 43, 82, 87, 98, 102, 118, 142, 145, 149, 168, 182, 185, 190, 196, 208.
- `db/github-actions-artifact.js` — L 85.24 / B 79.01 / F 100. Uncovered branches: 34 (need +2 for 80%). Uncovered functions: none. Lines with uncovered branches: 35, 36, 53, 55, 63, 90, 99, 104, 111, 135, 149, 161, 211, 220, 231, 235, 258, 262, 277, 288, 299, 306, 309, 325, 328, 348, 359, 360, 384, 390, 398, 435, 441, 443.
- `api/_pairing-readiness.js` — L 98.61 / B 79.12 / F 100. Uncovered branches: 19 (need +1 for 80%). Uncovered functions: none. Lines with uncovered branches: 81, 85, 101, 102, 107, 109, 115, 121, 127, 132, 140, 143, 168, 169, 170, 175, 201.
- `api/_schedule-email.js` — L 94.37 / B 79.2 / F 100. Uncovered branches: 26 (need +1 for 80%). Uncovered functions: none. Lines with uncovered branches: 34, 40, 48, 69, 73, 88, 160, 195, 196, 202, 204, 207, 221, 223, 230, 233, 246, 254, 255, 261, 266, 267, 277, 279, 280.
- `api/data.js` — L 90.57 / B 79.32 / F 91.78. Uncovered branches: 311 (need +11 for 80%). Uncovered functions: `isAdminCheck@93`, `getCallerAdmin@98`, `requireAdminDT@106`, `isLogRateLimited@548`, `status@1229`, `json@1229`. Lines with uncovered branches: 125, 131, 135, 136, 173, 174, 175, 187, 194, 195, 203, 204, 205, 209, 210, 221, 222, 223, 224, 226, 228, 229, 251, 257, 265, 280, 285, 303, 340, 393, 395, 399, 401, 413, 422, 442, 450, 455, 462, 463, ... (+248 more).
- `scripts/turso-production-migrate.mjs` — L 86.57 / B 79.47 / F 91.89. Uncovered branches: 47 (need +2 for 80%). Uncovered functions: `timeoutError@249`, `batch@281`, `environmentOptions@615`. Lines with uncovered branches: 89, 105, 114, 115, 159, 163, 183, 205, 219, 230, 232, 240, 289, 295, 321, 327, 341, 347, 387, 415, 418, 419, 420, 421, 424, 488, 506, 509, 518, 521, 542, 546, 555, 561, 575, 581, 585, 591, 599, 605, ... (+5 more).
- `db/turso-platform.js` — L 89.96 / B 79.84 / F 100. Uncovered branches: 26 (need +1 for 80%). Uncovered functions: none. Lines with uncovered branches: 32, 63, 65, 72, 76, 82, 91, 92, 123, 130, 144, 157, 161, 168, 176, 185, 192, 196, 197, 202, 235, 237, 262, 266, 283, 303.

**Never-loaded files.** `scripts/ui-screenshots.mjs` (Playwright screenshot tool, 868 lines), `scripts/execution-smoke.mjs` (live sandbox smoke test), `scripts/local-reset.mjs`, `scripts/generate-schema-readiness.mjs` and `scripts/validate-catalog.mjs` are not imported by any unit test. Together they count for about 2% of aggregate lines. Resolved by P5: the two browser/live-network tools are excluded (see "Excluded from scope"), and the other three now have `main()` guards and real tests.

## Proposed test-writing packages

The packages split the files with no overlap, so they can run in parallel. "Branches to add" is the sum, over the files below 80%, of the covered branches each file needs to reach 80% on its own. "Est. tests" is a rough count, about one focused test per two uncovered branches plus one per 40 uncovered lines.

| Package | Files (all) | Files below 80% | Lines | Branches | Functions | Branches to add for 80%/file | Lines to add | Est. tests |
|---|---|---|---|---|---|---|---|---|
| P1 auth / identity / password / activation / credentials | 17 | 10 | 92.2 | 76.5 | 98.3 | 133 | 3 | ~68 |
| P2 pairing / availability / schedule / sessions / code / AI | 25 | 13 | 92.3 | 77.1 | 98.7 | 218 | 0 | ~109 |
| P3 outbox / emails / invitations / circles / members | 13 | 10 | 93.3 | 73.7 | 97.0 | 127 | 0 | ~64 |
| P4 db migrations / inspector / readiness / backup evidence / data+ops APIs | 20 | 9 | 92.7 | 80.1 | 98.3 | 79 | 0 | ~40 |
| P5 scripts / ops tooling / retention / catalog | 24 | 17 | 83.6 | 80.5 | 94.7 | 139 | 877 | ~99 |

### P1 auth / identity / password / activation / credentials

All files: `api/_identity-linking.js`, `api/_password-reset.js`, `api/_email-activation.js`, `api/_admin-init.js`, `api/auth.js`, `api/_session-controls.js`, `api/_key-rotation.js`, `api/_credential-key-control.js`, `db/credential-key-control.js`, `scripts/credential-key-control.mjs`, `api/_google-oidc.js`, `api/_auth-config.js`, `api/_recent-auth.js`, `api/_auth-readiness.js`, `api/_local-runtime.js`, `api/_sentry.js`, `api/_db.js`

| File below 80% | Lines | Branches | Functions | Branches to add | Lines to add |
|---|---|---|---|---|---|
| `api/_identity-linking.js` | 89.88 | 62.26 | 100 | 38 | 0 |
| `api/_password-reset.js` | 92.78 | 63.19 | 96.15 | 25 | 0 |
| `scripts/credential-key-control.mjs` | 78.82 | 63.75 | 84.61 | 13 | 3 |
| `api/_email-activation.js` | 94.54 | 69.23 | 96.15 | 19 | 0 |
| `api/_admin-init.js` | 90.3 | 71.42 | 100 | 8 | 0 |
| `db/credential-key-control.js` | 97.91 | 72.09 | 100 | 4 | 0 |
| `api/_session-controls.js` | 92.84 | 76.21 | 100 | 7 | 0 |
| `api/_key-rotation.js` | 89.31 | 77.71 | 94.44 | 4 | 0 |
| `api/auth.js` | 91.27 | 78.41 | 100 | 14 | 0 |
| `api/_credential-key-control.js` | 91.86 | 79 | 100 | 1 | 0 |

### P2 pairing / availability / schedule / sessions / code / AI

All files: `api/_pairing-publication.js`, `api/_availability.js`, `api/_circle-pairing.js`, `api/_pairing-email.js`, `api/_pairing-readiness.js`, `api/_secondary-schedule.js`, `api/_secondary-schedule-email.js`, `api/_schedule-email.js`, `api/_meeting-link.js`, `api/_session-completion.js`, `api/_code-document.js`, `api/code-document.js`, `api/ai.js`, `api/_pairing.js`, `api/_pairing-cycle.js`, `api/_pairing-recovery.js`, `api/_pairing-evidence.js`, `api/_pairing-email-contract.js`, `api/_schedule.js`, `api/_messages.js`, `api/_pair-access.js`, `api/_pair-recap.js`, `api/_execution.js`, `api/_ai-readiness.js`, `api/video.js`

| File below 80% | Lines | Branches | Functions | Branches to add | Lines to add |
|---|---|---|---|---|---|
| `api/_code-document.js` | 86.7 | 62.67 | 97.72 | 50 | 0 |
| `api/_secondary-schedule-email.js` | 83.07 | 69.04 | 93.33 | 19 | 0 |
| `api/code-document.js` | 85.54 | 70.45 | 100 | 5 | 0 |
| `api/_pairing-publication.js` | 91.7 | 70.54 | 100 | 26 | 0 |
| `api/_secondary-schedule.js` | 90.76 | 71.42 | 96 | 17 | 0 |
| `api/_meeting-link.js` | 90.8 | 72.05 | 95 | 11 | 0 |
| `api/ai.js` | 91.64 | 72.22 | 100 | 37 | 0 |
| `api/_availability.js` | 89.86 | 72.25 | 100 | 26 | 0 |
| `api/_pairing-email.js` | 90.8 | 74.35 | 93.75 | 11 | 0 |
| `api/_session-completion.js` | 90.97 | 76.87 | 100 | 5 | 0 |
| `api/_circle-pairing.js` | 92.64 | 76.92 | 100 | 9 | 0 |
| `api/_pairing-readiness.js` | 98.61 | 79.12 | 100 | 1 | 0 |
| `api/_schedule-email.js` | 94.37 | 79.2 | 100 | 1 | 0 |

### P3 outbox / emails / invitations / circles / members

All files: `api/_outbox.js`, `api/_outbox-immediate.js`, `api/_outbox-delivery.js`, `api/_outbox-identity.js`, `api/_invitation-email.js`, `api/invitations.js`, `api/_circle-membership.js`, `api/_active-circle.js`, `api/_circle-archive.js`, `api/_circle-creation.js`, `api/_member-lifecycle.js`, `api/circles.js`, `api/members.js`

| File below 80% | Lines | Branches | Functions | Branches to add | Lines to add |
|---|---|---|---|---|---|
| `api/_circle-membership.js` | 94.93 | 64.24 | 94.73 | 26 | 0 |
| `api/_invitation-email.js` | 94.79 | 68.21 | 100 | 16 | 0 |
| `api/invitations.js` | 91.31 | 68.37 | 100 | 30 | 0 |
| `api/_active-circle.js` | 96 | 71.55 | 100 | 10 | 0 |
| `api/_outbox.js` | 92.45 | 72.91 | 95.23 | 25 | 0 |
| `api/_circle-archive.js` | 93.26 | 74.28 | 100 | 6 | 0 |
| `api/_outbox-immediate.js` | 95 | 75 | 100 | 2 | 0 |
| `api/_member-lifecycle.js` | 94.2 | 76.19 | 100 | 8 | 0 |
| `api/_circle-creation.js` | 91.61 | 78.16 | 93.75 | 3 | 0 |
| `api/_outbox-delivery.js` | 86.48 | 78.57 | 80 | 1 | 0 |

### P4 db migrations / inspector / readiness / backup evidence / data+ops APIs

All files: `api/_data-readiness.js`, `api/_health.js`, `api/_ops-readiness.js`, `api/data.js`, `api/ops.js`, `db/backup-evidence.js`, `db/check-constraint-state.js`, `db/executable-migrations.js`, `db/github-actions-artifact.js`, `db/membership-readiness.js`, `db/migration-contract.js`, `db/migration-ledger-readiness.js`, `db/migration-ledger.js`, `db/migration-plan.js`, `db/migration-runner.js`, `db/schema-inspector.js`, `db/schema-manifest.js`, `db/schema-readiness-manifest.js`, `db/stable-checksum.js`, `db/turso-platform.js`

| File below 80% | Lines | Branches | Functions | Branches to add | Lines to add |
|---|---|---|---|---|---|
| `db/migration-contract.js` | 98.34 | 33.33 | 100 | 5 | 0 |
| `db/migration-ledger.js` | 95.55 | 50 | 100 | 2 | 0 |
| `db/executable-migrations.js` | 80.39 | 62.06 | 100 | 6 | 0 |
| `db/backup-evidence.js` | 91.22 | 70.71 | 100 | 30 | 0 |
| `db/membership-readiness.js` | 97.99 | 75.71 | 100 | 3 | 0 |
| `api/ops.js` | 91.36 | 76.94 | 100 | 19 | 0 |
| `db/github-actions-artifact.js` | 85.24 | 79.01 | 100 | 2 | 0 |
| `api/data.js` | 90.57 | 79.32 | 91.78 | 11 | 0 |
| `db/turso-platform.js` | 89.96 | 79.84 | 100 | 1 | 0 |

### P5 scripts / ops tooling / retention / catalog

All files: `api/_catalog-provenance.js`, `api/_catalog.js`, `api/_chat-retention.js`, `scripts/catalog-provenance.mjs`, `scripts/chat-retention.mjs`, `scripts/check-backup-controls.mjs`, `scripts/check-crdt-bundle.mjs`, `scripts/check-deployability.mjs`, `scripts/check-runtime-ddl.mjs`, `scripts/check-turso-remote-sql.mjs`, `scripts/db-inspect.mjs`, `scripts/db-migrate.mjs`, `scripts/execution-smoke.mjs`, `scripts/generate-schema-readiness.mjs`, `scripts/github-backup-restore-watchdog.mjs`, `scripts/github-outbox-dispatch-watchdog.mjs`, `scripts/local-reset.mjs`, `scripts/local-server.mjs`, `scripts/production-smoke.mjs`, `scripts/turso-backup-restore-monitor.mjs`, `scripts/turso-backup-restore-rehearsal.mjs`, `scripts/turso-production-migrate.mjs`, `scripts/ui-screenshots.mjs`, `scripts/validate-catalog.mjs`

| File below 80% | Lines | Branches | Functions | Branches to add | Lines to add |
|---|---|---|---|---|---|
| `scripts/execution-smoke.mjs` | 0 | 0 | 0 | 1 | 77 |
| `scripts/generate-schema-readiness.mjs` | 0 | 0 | 0 | 1 | 7 |
| `scripts/local-reset.mjs` | 0 | 0 | 0 | 1 | 25 |
| `scripts/ui-screenshots.mjs` | 0 | 0 | 0 | 1 | 695 |
| `scripts/validate-catalog.mjs` | 0 | 0 | 0 | 1 | 8 |
| `scripts/check-crdt-bundle.mjs` | 84.37 | 40 | 100 | 2 | 0 |
| `scripts/chat-retention.mjs` | 40.49 | 57.89 | 57.14 | 5 | 65 |
| `api/_chat-retention.js` | 93.65 | 63.4 | 95 | 46 | 0 |
| `scripts/local-server.mjs` | 86.56 | 71.88 | 85.93 | 31 | 0 |
| `scripts/turso-backup-restore-monitor.mjs` | 93.97 | 73.46 | 100 | 7 | 0 |
| `api/_catalog-provenance.js` | 87.79 | 73.94 | 95 | 9 | 0 |
| `scripts/check-deployability.mjs` | 91.81 | 74.82 | 100 | 8 | 0 |
| `scripts/catalog-provenance.mjs` | 89.28 | 75.78 | 90.47 | 6 | 0 |
| `scripts/production-smoke.mjs` | 95.03 | 76.06 | 100 | 5 | 0 |
| `scripts/turso-backup-restore-rehearsal.mjs` | 91.41 | 78.19 | 96.55 | 10 | 0 |
| `scripts/github-backup-restore-watchdog.mjs` | 94.63 | 78.75 | 100 | 3 | 0 |
| `scripts/turso-production-migrate.mjs` | 86.57 | 79.47 | 91.89 | 2 | 0 |

#### P5 results

Measured on the P5 branch with `npm run test:coverage:report` (all unit
tests). Every P5 file in scope is at 80% or more on all three metrics.

| File | Before L / B / F | After L / B / F |
|---|---|---|
| `api/_catalog-provenance.js` | 87.79 / 73.94 / 95 | 99.1 / 100 / 95 |
| `api/_chat-retention.js` | 93.65 / 63.4 / 95 | 98.48 / 98.88 / 100 |
| `scripts/catalog-provenance.mjs` | 89.28 / 75.78 / 90.47 | 98.21 / 93.95 / 100 |
| `scripts/chat-retention.mjs` | 40.49 / 57.89 / 57.14 | 100 / 100 / 100 |
| `scripts/check-crdt-bundle.mjs` | 84.37 / 40 / 100 | 100 / 90 / 100 |
| `scripts/check-deployability.mjs` | 91.81 / 74.82 / 100 | 100 / 98.52 / 100 |
| `scripts/generate-schema-readiness.mjs` | 0 / 0 / 0 | 100 / 88.88 / 100 |
| `scripts/github-backup-restore-watchdog.mjs` | 94.63 / 78.75 / 100 | 100 / 96.81 / 100 |
| `scripts/local-reset.mjs` | 0 / 0 / 0 | 100 / 85.71 / 100 |
| `scripts/local-server.mjs` | 86.56 / 71.88 / 85.93 | 94.9 / 88.37 / 93.75 |
| `scripts/production-smoke.mjs` | 95.03 / 76.06 / 100 | 99.23 / 97.29 / 100 |
| `scripts/turso-backup-restore-monitor.mjs` | 93.97 / 73.46 / 100 | 100 / 96.05 / 100 |
| `scripts/turso-backup-restore-rehearsal.mjs` | 91.41 / 78.19 / 96.55 | 93.95 / 84.13 / 97.7 |
| `scripts/turso-production-migrate.mjs` | 86.57 / 79.47 / 91.89 | 96.5 / 89.31 / 97.29 |
| `scripts/validate-catalog.mjs` | 0 / 0 / 0 | 100 / 80 / 100 |
| `scripts/execution-smoke-checks.mjs` (new) | n/a | 100 / 100 / 100 |
| `scripts/ui-screenshots-policy.mjs` (new) | n/a | 100 / 100 / 100 |
| `scripts/execution-smoke.mjs` | 0 / 0 / 0 | excluded |
| `scripts/ui-screenshots.mjs` | 0 / 0 / 0 | excluded |

The other P5 scripts were already above 80% and were not changed.
`api/_catalog-provenance.js` functions stay at 95% because
`requireNullableText` has no callers; it is dead code. What is still
uncovered, on purpose: signal handlers that only run in a real CLI process
(`local-server` `stop`/`notReadyHandler`, rehearsal `interrupt`), the
`local-server` IPv6 display path, lock-file races in `catalog-provenance.mjs`,
and the `process.argv[1] || ''` fallback in main guards.

## Full per-file table

| File | Lines % | Branches % | Functions % | Lines (cov/total) | Branches (cov/total) | Functions (cov/total) | Below 80 |
|---|---|---|---|---|---|---|---|
| `api/_active-circle.js` | 96 | 71.55 | 100 | 312/325 | 83/116 | 21/21 | B |
| `api/_admin-init.js` | 90.3 | 71.42 | 100 | 205/227 | 65/91 | 10/10 | B |
| `api/_ai-readiness.js` | 100 | 96.15 | 100 | 122/122 | 50/52 | 13/13 |  |
| `api/_auth-config.js` | 98.03 | 96.34 | 100 | 100/102 | 79/82 | 8/8 |  |
| `api/_auth-readiness.js` | 100 | 100 | 100 | 31/31 | 10/10 | 2/2 |  |
| `api/_availability.js` | 89.86 | 72.25 | 100 | 683/760 | 237/328 | 36/36 | B |
| `api/_catalog-provenance.js` | 87.79 | 73.94 | 95 | 295/336 | 105/142 | 19/20 | B |
| `api/_catalog.js` | 98.68 | 94.54 | 100 | 1350/1368 | 658/696 | 78/78 |  |
| `api/_chat-retention.js` | 93.65 | 63.4 | 95 | 930/993 | 175/276 | 38/40 | B |
| `api/_circle-archive.js` | 93.26 | 74.28 | 100 | 263/282 | 78/105 | 10/10 | B |
| `api/_circle-creation.js` | 91.61 | 78.16 | 93.75 | 295/322 | 111/142 | 15/16 | B |
| `api/_circle-membership.js` | 94.93 | 64.24 | 94.73 | 525/553 | 106/165 | 36/38 | B |
| `api/_circle-pairing.js` | 92.64 | 76.92 | 100 | 642/693 | 220/286 | 21/21 | B |
| `api/_code-document.js` | 86.7 | 62.67 | 97.72 | 639/737 | 178/284 | 43/44 | B |
| `api/_credential-key-control.js` | 91.86 | 79 | 100 | 192/209 | 79/100 | 14/14 | B |
| `api/_data-readiness.js` | 100 | 100 | 100 | 210/210 | 48/48 | 28/28 |  |
| `api/_db.js` | 96.02 | 82.02 | 100 | 411/428 | 178/217 | 32/32 |  |
| `api/_email-activation.js` | 94.54 | 69.23 | 96.15 | 485/513 | 117/169 | 25/26 | B |
| `api/_execution.js` | 98.48 | 91.76 | 95.45 | 390/396 | 156/170 | 21/22 |  |
| `api/_google-oidc.js` | 94.17 | 83.05 | 100 | 210/223 | 98/118 | 14/14 |  |
| `api/_health.js` | 100 | 92.55 | 100 | 142/142 | 87/94 | 8/8 |  |
| `api/_identity-linking.js` | 89.88 | 62.26 | 100 | 533/593 | 132/212 | 29/29 | B |
| `api/_invitation-email.js` | 94.79 | 68.21 | 100 | 346/365 | 88/129 | 22/22 | B |
| `api/_key-rotation.js` | 89.31 | 77.71 | 94.44 | 326/365 | 136/175 | 17/18 | B |
| `api/_local-runtime.js` | 96.49 | 87.93 | 100 | 55/57 | 51/58 | 5/5 |  |
| `api/_meeting-link.js` | 90.8 | 72.05 | 95 | 326/359 | 98/136 | 19/20 | B |
| `api/_member-lifecycle.js` | 94.2 | 76.19 | 100 | 455/483 | 144/189 | 18/18 | B |
| `api/_messages.js` | 98.47 | 88.88 | 100 | 258/262 | 112/126 | 21/21 |  |
| `api/_ops-readiness.js` | 100 | 85.45 | 100 | 162/162 | 47/55 | 16/16 |  |
| `api/_outbox-delivery.js` | 86.48 | 78.57 | 80 | 96/111 | 22/28 | 4/5 | B |
| `api/_outbox-identity.js` | 100 | 100 | 100 | 14/14 | 4/4 | 2/2 |  |
| `api/_outbox-immediate.js` | 95 | 75 | 100 | 95/100 | 24/32 | 6/6 | B |
| `api/_outbox.js` | 92.45 | 72.91 | 95.23 | 870/941 | 253/347 | 60/63 | B |
| `api/_pair-access.js` | 100 | 92.85 | 100 | 57/57 | 13/14 | 4/4 |  |
| `api/_pair-recap.js` | 93.49 | 81.43 | 100 | 316/338 | 136/167 | 21/21 |  |
| `api/_pairing-cycle.js` | 95.65 | 90.74 | 100 | 154/161 | 49/54 | 10/10 |  |
| `api/_pairing-email-contract.js` | 100 | 100 | 100 | 3/3 | 1/1 | 0/0 |  |
| `api/_pairing-email.js` | 90.8 | 74.35 | 93.75 | 415/457 | 145/195 | 15/16 | B |
| `api/_pairing-evidence.js` | 100 | 100 | 100 | 37/37 | 10/10 | 2/2 |  |
| `api/_pairing-publication.js` | 91.7 | 70.54 | 100 | 630/687 | 194/275 | 25/25 | B |
| `api/_pairing-readiness.js` | 98.61 | 79.12 | 100 | 213/216 | 72/91 | 11/11 | B |
| `api/_pairing-recovery.js` | 91.91 | 88.88 | 100 | 91/99 | 40/45 | 6/6 |  |
| `api/_pairing.js` | 96.73 | 87.3 | 100 | 178/184 | 55/63 | 12/12 |  |
| `api/_password-reset.js` | 92.78 | 63.19 | 96.15 | 373/402 | 91/144 | 25/26 | B |
| `api/_recent-auth.js` | 100 | 82.85 | 100 | 69/69 | 29/35 | 5/5 |  |
| `api/_schedule-email.js` | 94.37 | 79.2 | 100 | 285/302 | 99/125 | 15/15 | B |
| `api/_schedule.js` | 98.63 | 94.6 | 100 | 289/293 | 193/204 | 20/20 |  |
| `api/_secondary-schedule-email.js` | 83.07 | 69.04 | 93.33 | 324/390 | 116/168 | 14/15 | B |
| `api/_secondary-schedule.js` | 90.76 | 71.42 | 96 | 501/552 | 140/196 | 24/25 | B |
| `api/_sentry.js` | 99.01 | 88.37 | 100 | 202/204 | 76/86 | 13/13 |  |
| `api/_session-completion.js` | 90.97 | 76.87 | 100 | 353/388 | 123/160 | 23/23 | B |
| `api/_session-controls.js` | 92.84 | 76.21 | 100 | 402/433 | 141/185 | 26/26 | B |
| `api/ai.js` | 91.64 | 72.22 | 100 | 812/886 | 338/468 | 34/34 | B |
| `api/auth.js` | 91.27 | 78.41 | 100 | 1235/1353 | 654/834 | 50/50 | B |
| `api/circles.js` | 89.94 | 82.1 | 100 | 179/199 | 78/95 | 5/5 |  |
| `api/code-document.js` | 85.54 | 70.45 | 100 | 71/83 | 31/44 | 4/4 | B |
| `api/data.js` | 90.57 | 79.32 | 91.78 | 2499/2759 | 1193/1504 | 67/73 | B |
| `api/invitations.js` | 91.31 | 68.37 | 100 | 568/622 | 173/253 | 21/21 | B |
| `api/members.js` | 98.85 | 88.05 | 100 | 172/174 | 118/134 | 8/8 |  |
| `api/ops.js` | 91.36 | 76.94 | 100 | 973/1065 | 464/603 | 41/41 | B |
| `api/video.js` | 95.47 | 81.13 | 100 | 717/751 | 357/440 | 34/34 |  |
| `db/backup-evidence.js` | 91.22 | 70.71 | 100 | 905/992 | 227/321 | 47/47 | B |
| `db/check-constraint-state.js` | 100 | 93.75 | 100 | 72/72 | 30/32 | 5/5 |  |
| `db/credential-key-control.js` | 97.91 | 72.09 | 100 | 94/96 | 31/43 | 5/5 | B |
| `db/executable-migrations.js` | 80.39 | 62.06 | 100 | 82/102 | 18/29 | 4/4 | B |
| `db/github-actions-artifact.js` | 85.24 | 79.01 | 100 | 416/488 | 128/162 | 25/25 | B |
| `db/membership-readiness.js` | 97.99 | 75.71 | 100 | 293/299 | 53/70 | 4/4 | B |
| `db/migration-contract.js` | 98.34 | 33.33 | 100 | 119/121 | 3/9 | 1/1 | B |
| `db/migration-ledger-readiness.js` | 95.31 | 81.66 | 100 | 122/128 | 49/60 | 7/7 |  |
| `db/migration-ledger.js` | 95.55 | 50 | 100 | 43/45 | 3/6 | 2/2 | B |
| `db/migration-plan.js` | 94.96 | 85.22 | 100 | 264/278 | 75/88 | 3/3 |  |
| `db/migration-runner.js` | 93.42 | 86.99 | 100 | 426/456 | 194/223 | 22/22 |  |
| `db/schema-inspector.js` | 97.15 | 85.71 | 100 | 785/808 | 366/427 | 40/40 |  |
| `db/schema-manifest.js` | 99.46 | 92.85 | 100 | 369/371 | 13/14 | 4/4 |  |
| `db/schema-readiness-manifest.js` | 100 | 100 | 100 | 3/3 | 1/1 | 0/0 |  |
| `db/stable-checksum.js` | 100 | 100 | 100 | 13/13 | 9/9 | 2/2 |  |
| `db/turso-platform.js` | 89.96 | 79.84 | 100 | 278/309 | 103/129 | 27/27 | B |
| `scripts/catalog-provenance.mjs` | 89.28 | 75.78 | 90.47 | 400/448 | 97/128 | 19/21 | B |
| `scripts/chat-retention.mjs` | 40.49 | 57.89 | 57.14 | 66/163 | 11/19 | 4/7 | LBF |
| `scripts/check-backup-controls.mjs` | 99.16 | 86.4 | 100 | 596/601 | 108/125 | 28/28 |  |
| `scripts/check-crdt-bundle.mjs` | 84.37 | 40 | 100 | 27/32 | 2/5 | 1/1 | B |
| `scripts/check-deployability.mjs` | 91.81 | 74.82 | 100 | 415/452 | 107/143 | 16/16 | B |
| `scripts/check-runtime-ddl.mjs` | 92.1 | 84.1 | 96.29 | 420/456 | 217/258 | 26/27 |  |
| `scripts/check-turso-remote-sql.mjs` | 97.15 | 93 | 100 | 239/246 | 133/143 | 13/13 |  |
| `scripts/credential-key-control.mjs` | 78.82 | 63.75 | 84.61 | 175/222 | 51/80 | 11/13 | LB |
| `scripts/db-inspect.mjs` | 92.85 | 95.45 | 100 | 52/56 | 21/22 | 4/4 |  |
| `scripts/db-migrate.mjs` | 94.55 | 86.92 | 100 | 347/367 | 133/153 | 22/22 |  |
| `scripts/execution-smoke.mjs` | 0 | 0 | 0 | 0/96 | 0/1 | 0/1 | LBF |
| `scripts/generate-schema-readiness.mjs` | 0 | 0 | 0 | 0/8 | 0/1 | 0/1 | LBF |
| `scripts/github-backup-restore-watchdog.mjs` | 94.63 | 78.75 | 100 | 406/429 | 152/193 | 28/28 | B |
| `scripts/github-outbox-dispatch-watchdog.mjs` | 93.8 | 80.35 | 100 | 303/323 | 135/168 | 21/21 |  |
| `scripts/local-reset.mjs` | 0 | 0 | 0 | 0/31 | 0/1 | 0/1 | LBF |
| `scripts/local-server.mjs` | 86.56 | 71.88 | 85.93 | 1070/1236 | 271/377 | 55/64 | B |
| `scripts/production-smoke.mjs` | 95.03 | 76.06 | 100 | 249/262 | 89/117 | 15/15 | B |
| `scripts/turso-backup-restore-monitor.mjs` | 93.97 | 73.46 | 100 | 265/282 | 72/98 | 14/14 | B |
| `scripts/turso-backup-restore-rehearsal.mjs` | 91.41 | 78.19 | 96.55 | 1513/1655 | 416/532 | 84/87 | B |
| `scripts/turso-production-migrate.mjs` | 86.57 | 79.47 | 91.89 | 619/715 | 182/229 | 34/37 | B |
| `scripts/ui-screenshots.mjs` | 0 | 0 | 0 | 0/868 | 0/1 | 0/1 | LBF |
| `scripts/validate-catalog.mjs` | 0 | 0 | 0 | 0/10 | 0/1 | 0/1 | LBF |
