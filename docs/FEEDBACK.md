# Product feedback (issue #353)

Status: backend data model and API, migration v22 (decision
[ID-91](IMPLEMENTED_DECISIONS.md#id-91-product-feedback--shared-platform-for-bug-reports-feature-requests-and-product-feedback-data-model--api)).
The triage UI and the member-facing feedback form are built separately
against the contract below. There is no triage UI yet: items stay `open`
until a later issue adds status changes.

## Feature flag and capability

| Setting | Effect |
| --- | --- |
| `FEEDBACK_ENABLED=true` and `CIRCLE_MEMBERSHIP_ENABLED=true` | Enables both endpoints, once migration v22 is applied. Otherwise every endpoint returns `404 {"error":"not found"}`. Default `false`. |
| Migration v22 pending | The endpoints still return `404`, exactly as if the flag were off (ID-87 pending-additive). The app stays ready on a v21 database. |
| `/api/auth/capabilities` | Adds **no** key. Nothing advertises feedback until the UI lands; the UI will read the flag from its own capability then. |

The admin notification additionally needs `RESEND_API_KEY`, `RESEND_FROM`,
and a canonical HTTPS `APP_URL` in production (local runtime: loopback
HTTP capture).

## Submission

`POST /api/feedback` (rewritten to `/api/data?endpoint=feedback`)

- Session required (`401`); caller must be an active member of their
  active circle (`403` without a membership, `409` with
  `circle_selection_required` when several circles are active and none is
  selected). The item is stored against the active circle.
- JSON body, only these keys:

| Field | Rules |
| --- | --- |
| `kind` | Required. `bug`, `feature_request`, or `feedback`. |
| `title` | Required string. Trimmed, NFC-normalized; 1–120 code points; no control, line-separator, or bidi-override characters. |
| `body` | Required string. Trimmed, CRLF→LF; 1–4000 code points. Newlines and tabs allowed; other controls rejected. |
| `diagnostics` | Optional JSON object, bugs only. At most 20 fields, scalar values (text ≤500 chars, finite numbers, true/false, null), at most 4096 bytes serialized. Keys must be plain field names (`[A-Za-z0-9_.-]+`): an email, IP literal, JWT or token as a key is rejected. Any other kind with diagnostics → `400`. |
| `idempotency_key` | Required string, 8–128 characters. A retry with the same key and the same (redacted) payload replays the stored item; the same key with different content → `409 {"code":"feedback_idempotency_conflict"}`. Idempotency is per author: two members may reuse a key. Two simultaneous same-key POSTs that collide on the unique index re-read the winner's row and replay it (or 409) instead of failing with `503`. |

- Before storage, title, body and diagnostics pass through the shared
  server-side redaction (`api/_client-log-policy.js`): emails, tokens,
  secrets, JWTs, credentials, IP addresses and user agents become
  `[email]`, `[redacted]`, `[ip]` and friends. No raw IP or user agent is
  stored anywhere in the feedback tables (ID-82).
- Rate limits, on the shared `auth_rate_limits` table with keyed hashes:
  10 submissions per rolling hour and 30 per rolling day, enforced
  separately per member and per client address (IPv6 keyed by its /64).
  The first exhausted dimension stops. Invalid input (`400`) never spends
  budget, and neither does an exact replay or a same-key conflict: the
  idempotency key is looked up before the limiter. Exhaustion →
  `429 {"error":"too many requests; try again later","retry_after_seconds":n}` plus `Retry-After`.

Responses:

| Status | Body | When |
| --- | --- | --- |
| `201` | `{"ok":true,"replayed":false,"item":{…}}` | Stored. |
| `200` | `{"ok":true,"replayed":true,"item":{…}}` | The same key and payload were already stored. No second row, no second admin email. |
| `400` | `{"error":"invalid feedback","fields":{…}}` | Field validation. |
| `401` | `{"error":"authentication required"}` | No valid session. |
| `403` | `{"error":"circle membership required"}` | No active membership. |
| `404` | `{"error":"not found"}` | Flag off, or v22 not yet applied. |
| `409` | `{"error":"idempotency key already used for different feedback","code":"feedback_idempotency_conflict"}` | Same key, different content. |
| `409` | `{"error":"circle selection required","code":"circle_selection_required"}` | Several active circles, none selected. |
| `429` | `{"error":"too many requests; try again later","retry_after_seconds":n}` | Rate limit. |
| `503` | `{"error":"feedback unavailable"}` | Storage failure. |

`item` is `{id, circle_id, author_user_id, kind, title, body, status,
visibility:"private", diagnostics, vote_count, created_at, updated_at,
closed_at}` with ISO-8601 timestamps. `status` is `open` until the triage
UI lands; `visibility` is always `private` for now.

## My submissions

`GET /api/feedback/mine` (rewritten to `/api/data?endpoint=feedback-mine`)

- Same session and active-circle rules as submission. The list is the
  caller's own items in the active circle, newest first.
- Query parameters: `limit` 1–100 (default 50), `cursor` opaque
  `next_cursor` from the previous page. Anything else → `400`.

```json
{
  "ok": true,
  "items": [
    {"id":"uuid","circle_id":1,"author_user_id":2,"kind":"bug","title":"…","body":"…",
     "status":"open","visibility":"private","diagnostics":null,"vote_count":0,
     "created_at":"ISO-8601","updated_at":"ISO-8601","closed_at":null}
  ],
  "next_cursor": "opaque-or-null"
}
```

## Admin notification

Outbox event `feedback.submitted`, version 1, payload
`{feedback_id, circle_id, author_user_id, recipient_user_id, kind, title,
template_version:1}`; idempotency key
`feedback-submitted/v1/<feedback_id>/<admin_id>`, so each admin gets at
most one email per item. One event is queued per admin recipient: every
account with `is_admin=1` (not demo), plus every account whose email is in
`ADMIN_EMAILS`. It is attempted immediately after the response (the
`waitUntil` path) and otherwise by the outbox cron. At delivery the
handler re-reads state and suppresses when the item is gone, the
recipient is no longer an app admin, they have email notifications
switched off (`user_notification_prefs.email_enabled=0`), or their email
is invalid. While `FEEDBACK_ENABLED` is off the handler suppresses with
`FEEDBACK_DISABLED`, so queued rows drain instead of aging into a backlog
alert. The email contains only the kind, the redacted title and a
link to the triage view (`/?view=feedback&id=<feedback_id>`, which the
triage UI will implement); the body is never emailed.

## Data, privacy, and retention

- Tables `feedback_items`, `feedback_votes`, `feedback_events`
  (migration v22, additive). Items hold the redacted title and body, the
  author and circle ids, kind, status, visibility, optional bug
  diagnostics, the client's idempotency key, and `closed_at` once
  closed. Votes are one upvote (`value=1`) per member per item
  (unique `feedback_id, user_id`). Events are the append-only audit trail
  (`feedback.created`, `feedback.status_changed`) with the acting user
  and a small detail object.
- Deleting the item cascades its votes and events (the deletion and
  retention code also deletes them explicitly, so it never depends on
  foreign-key enforcement on the calling connection).
- Retention: open items are kept until they are closed. Closed items are
  deleted after 12 months by `runFeedbackRetention`, bounded (500 rows per
  batch, at most 10 batches) inside the weekly `/api/cron/weekly` sweep.
  The outbox PII retention (ID-83) also removes the title from delivered or
  suppressed `feedback.submitted` rows after 7 days and from dead letters
  after 30 days.
  It runs regardless of `FEEDBACK_ENABLED`, so stored rows age out after
  the flag is turned off. A failure is logged as an ops error and
  retried next week; it never blocks pairing publication.
- Account deletion (#339, ID-81): the member's items, the votes they
  cast, and the events on their items are deleted; events they acted in
  keep the event with the actor cleared; queued `feedback.submitted`
  notifications about their submissions are suppressed and lose their
  title. The deletion probes the feedback tables directly
  (`SELECT … LIMIT 0`) and treats a missing table as not installed, so it
  works on a v21 database too (no feedback rows can exist there). See
  `docs/ACCOUNT_DELETION.md`.
- Export (#365, ID-90) includes the member's own feedback items and
  only the votes they cast: a vote on another member's item exports as
  the member's own vote, without that item's title or body; votes other
  members cast on the member's items are not exported. Feedback events
  are excluded — they are an append-only audit trail.

## Release order (ID-87)

1. **Merge** with the database still at v21. Production stays ready on
   v21; admin diagnostics shows *Degraded* with "pending additive
   migration v22"; the endpoints answer `404`.
2. **Run the cutover for v22** with the protected sequence in
   `docs/TURSO_PRODUCTION_MIGRATION.md`: a fresh rehearsal from the merged
   `main` commit, then `status` (`nextVersion` is 22), then `apply` 22.
   The app stays ready throughout.
3. **Turn `FEEDBACK_ENABLED` on.** The schema capability notices the
   applied migration within 30 seconds.

Rollback: turn `FEEDBACK_ENABLED` off first. Use PITR only if the tables
themselves are the problem; never roll code back below the database.
