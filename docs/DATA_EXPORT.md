# Member data export (download my data)

Issue #365, decision ID-89. Behind `DATA_EXPORT_ENABLED` (default off).
No migration. The endpoint lives in the existing `api/auth.js` function
(`GET /api/auth/account/export`, via the `vercel.json` rewrite), so no new
serverless function is added.

## What a member gets

One `GET /api/auth/account/export` returns a JSON archive
(`randori-circle-data-export.json`, `version: 1`) of the requesting member's
own data:

- `profile` — email, display name, colour, bio, time zone, interview focus,
  LeetCode handle, phone, availability, admin/demo flags, and
  `google_linked` (a boolean only; the Google subject is not exported).
- `memberships` — every circle membership with the circle's public id, name,
  role, status and the inviter by display name.
- `availability` — the member's pairing-cycle availability decisions.
- `pairings` — primary pair groups and participation rows, plus
  secondary-circle pairing groups and eligibility snapshots.
- `schedules` — primary and secondary schedules, secondary schedule
  proposals, and meeting links for the member's own pair groups.
- `session_completions` and `session_controls` — the member's completion
  receipts and the timer / interview-role controls for their pair groups.
- `messages` — only messages the member sent.
- `code_runs` — the member's own code runs, solo and in pair rooms.
- `notification_preferences`, `custom_questions` (authored by the member),
  `invitations` (sent and accepted), `invite_requests` (the member's own
  pending requests).
- `ai` — AI sessions the member started, feedback on those sessions, AI
  consent, and per-month AI usage and reservations.
- `feedback` — the member's own product-feedback items and votes, when the
  feedback tables exist (see below).
- `excluded_tables` — every account-deletion inventory table that is not
  exported, with the reason, so the archive is explicit about what it
  leaves out.
- `counts` — row counts per section.

## Partner privacy

Partners appear by display name only, the same rule as the member's history
views: no partner ids, emails, phones, hashes or tokens anywhere in the
archive. A partner's chat messages are the partner's data and are never
exported, even though both partners see the conversation in the room.
Shared pair workspaces (`pair_code_documents`, `pair_room_snapshots`) are
not exported, because they hold the partner's contributions too.

## What is deliberately not exported

`DATA_EXPORT_TABLE_COVERAGE` in `api/_data-export.js` accounts for every
table in the account-deletion inventory (`api/_account-deletion.js`):
each table is either exported through a section or excluded with a reason.
The excluded classes are:

- Secrets and credential artefacts: password hashes, token hashes, Google
  subjects, sealed outbox envelopes, session hashes, rate-limit keys.
- Ephemeral records with no user content: sessions, recent-auth proofs,
  per-session circle contexts, video signalling.
- Security and audit trails: identity audit events, circle audit events,
  circle-creation idempotency records, outbox audit events.
- Joint pair documents and operational logs/app logs, as above.
- Rows that cannot be attributed to one member: the legacy `users` roster,
  `pairing_week_runs` (all participants' ids), decided invite requests
  (their email is scrubbed on decision).

A future inventory table with no explicit coverage entry is excluded at
runtime ("not yet reviewed") and fails
`tests/unit/data-export.test.mjs` until the entry is written.

## Authorization, re-authentication and rate limits

- The session alone chooses the account. A signed-out request gets 401.
- The export requires recent authentication (a sign-in from the last
  10 minutes, `api/_recent-auth.js`); without it the endpoint answers 403
  `recent_auth_required`. The check runs before the rate limit, so a stale
  proof does not burn export quota. In the UI the member confirms through
  Account security (or signs out and signs in again) and then retries.
- Rate limit: 5 exports per account and 20 per IP per 15 minutes
  (`data-export` bucket in `api/auth.js`); over the limit answers 429.
- With the flag off the endpoint answers 404 like an unknown endpoint, the
  `dataExport` capability is not advertised, and Edit profile never
  downloads `assets/data-export.js`.

## Size bound

Every section is capped (`DATA_EXPORT_SECTION_LIMITS`: 2,000 own messages,
1,000 code runs, 500–1,000 rows elsewhere) and the whole serialised archive
must fit `DATA_EXPORT_MAX_BYTES` (5 MiB). Over the bound the endpoint
answers 413 `export_too_large` instead of a partial or oversized response;
it does not chunk. 5 MiB is far above a real member archive and well inside
the serverless response budget.

## Feedback (#353)

`#353` (product feedback: `feedback_items`, `feedback_votes`,
`feedback_events`) is landing in parallel. The export probes for those
tables at request time and includes the member's own items and votes when
they exist; when they do not exist it reports
`feedback.included: false` and skips them cleanly. Feedback events (audit)
are never exported. Column names are discovered with `PRAGMA table_info`,
so a feedback table whose final #353 schema names its author/voter column
differently is skipped rather than failing the export. A follow-up issue
(#385) tracks confirming the #353 column names and the inventory entry
once #353 lands. (The `ai.feedback` section is unrelated: feedback on the member's
own AI sessions, which predates #353.)

## Privacy Policy

`privacy.html` ("Your choices and rights") describes the download: what it
contains, what it leaves out, the recent-sign-in requirement, and that
partners appear by display name only.

## Tests

- `tests/unit/data-export.test.mjs` — the builder on a migrated database:
  every inventory table covered, partner privacy (no partner ids/emails/
  messages in the archive), feedback skipped when its tables are absent and
  included when they are present, the size bound, and section caps.
- `tests/unit/data-export-api.test.mjs` — the route: flag off 404, 401, 403
  without recent auth, rate limit 429, 413, the `vercel.json` rewrite and
  the capability.
- `tests/unit/data-export-ui.test.mjs` — the Edit-profile section: copy,
  download, re-auth hint, rate-limit / too-large / signed-out copy, and
  request fencing.
- `tests/e2e/golden-data-export-real-runtime.spec.ts` — golden path
  (row 25 in `docs/testing/E2E_GOLDEN_PATHS.md`).
