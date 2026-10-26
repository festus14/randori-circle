# Member data export (download my data)

Issue #365, decision ID-90. Behind `DATA_EXPORT_ENABLED` (default off).
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
- `created_circles` — circles the member created but holds no membership
  for (public id, name, primary/archived flags, created date). Circles
  they belong to appear in `memberships` only, never duplicated here.
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
  `invitations` (sent, accepted, and received — pending, unexpired
  invitations addressed to the member, matched by email hash),
  `invite_requests` (the member's own pending requests).
- `ai` — AI sessions the member started, feedback on those sessions, AI
  consent, and per-month AI usage and reservations.
- `feedback` — the member's own product-feedback items and votes, when the
  feedback tables exist (see below).
- `excluded_tables` — every account-deletion inventory table that is not
  exported, with the reason, so the archive is explicit about what it
  leaves out.
- `truncated_sections` — every section that hit its per-section cap (see
  Size bound), so the archive is explicit about what it left out. Empty
  when nothing was capped.
- `counts` — exported row counts per section (capped sections count the
  rows actually in the archive, not the uncapped total).

## Partner privacy

Partners appear by display name only, the same rule as the member's history
views: no partner ids, emails, phones, hashes or tokens anywhere in the
archive. A partner's chat messages are the partner's data and are never
exported, even though both partners see the conversation in the room.
Shared pair workspaces (`pair_code_documents`, `pair_room_snapshots`) are
not exported, because they hold the partner's contributions too.

Schedule proposals are projected, not copied: stored
`pair_schedules.proposed_times` mixes legacy bare instants with modern
`{instant, proposed_by: <numeric member id>}` entries, and the raw
`proposed_by` id is another member's id whenever the partner proposed the
time. The export emits only `{instant, proposed_by_me}` for each entry
(`proposed_by_me: null` for a legacy entry, whose proposer is unknown),
so no raw partner id reaches the archive. A non-array
`proposed_times` value is normalised to a single
`{instant, proposed_by_me: null}` entry, with the instant kept only
when the stored value was a bare string (otherwise `null`). The same audit found no other
raw partner numeric id in the export: the remaining JSON blobs are the
member's own rows' payloads (attestation snapshots in code runs hold
only week/pair-group ids, hashes and signatures).

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
- Used or revoked invitations addressed to the member: a used one is in
  `invitations.accepted`; a revoked one is not exported.
- Expired invitations addressed to the member: the received query
  filters on `datetime(expires_at) > datetime('now')`, so an
  expired-but-unused invitation is not exported as `pending` (it is
  excluded, not relabelled `expired`).

A future inventory table with no explicit coverage entry is excluded at
runtime ("not yet reviewed") and `tests/unit/data-export.test.mjs`
asserts that no coverage entry carries that fallback reason and that the
coverage list deep-equals a hard-coded list of the 45 expected tables
(table, section, included) — so adding a table to the inventory,
removing one, or deleting an explicit entry all fail the test until an
explicit entry is written.

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

Every section is capped (`DATA_EXPORT_SECTION_LIMITS` in
`api/_data-export.js`, real caps, rows): memberships 100, availability
500, primary pairings 500, participations 500, secondary pairing groups
500, secondary eligibility 500, primary schedules 500, secondary
schedules 500, schedule proposals 1,000, meeting links 500, session
completions 1,000, session controls 500, messages 2,000, code runs 1,000,
custom questions 500, invitations sent 500, invitations accepted 500,
invitations received 500, created circles 100, invite requests 100, AI
sessions 200, AI feedback 500, AI usage 120, AI reservations 500,
feedback items 500, feedback votes 1,000.

Capping is disclosed, not silent: each capped query fetches one row past
its cap, and any section that had more rows than its cap is listed in
the archive's `truncated_sections` (and, for product feedback, in
`feedback.truncated_items` / `feedback.truncated_votes`). `counts` holds
the exported (capped) row counts. The Edit-profile section and
`privacy.html` say the same, so a member can tell a capped archive from
a complete one.

The whole serialised archive must also fit `DATA_EXPORT_MAX_BYTES`
(5,000,000 bytes = 5 MB). Over that bound the endpoint answers 413
`export_too_large` instead of a partial or oversized response; it does
not chunk. 5 MB is far above a real member archive and well inside the
serverless response budget.

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
contains (including session controls, notification preferences, AI
feedback/usage/reservations, received invitations and created circles),
what it leaves out, the recent-sign-in requirement, the per-section caps
and `truncated_sections` disclosure, and that partners appear by display
name only.

## Tests

- `tests/unit/data-export.test.mjs` — the builder on a migrated database:
  every inventory table covered (hard-coded 45-table coverage list, with
  the three mutation checks), partner privacy (no partner ids/emails/
  messages in the archive, including a modern partner schedule proposal),
  received invitations and created circles, feedback skipped when its
  tables are absent and included when they are present, the size bound,
  section caps, and `truncated_sections` disclosure when a cap is hit.
- `tests/unit/data-export-api.test.mjs` — the route: flag off 404, 401, 403
  without recent auth, rate limit 429, 413, the `vercel.json` rewrite and
  the capability.
- `tests/unit/data-export-ui.test.mjs` — the Edit-profile section: copy,
  download, re-auth hint, rate-limit / too-large / signed-out copy, and
  request fencing.
- `tests/e2e/golden-data-export-real-runtime.spec.ts` — golden path
  (row 25 in `docs/testing/E2E_GOLDEN_PATHS.md`). This spec uses the
  same `expectAccessible` helper pattern as the account-deletion golden
  spec; it will pick up the fix for that helper from #390, which owns it.
