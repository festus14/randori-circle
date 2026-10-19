# Invite requests (WP-L2)

Status: backend, owner review API, and migration v21 (decision
[ID-66](IMPLEMENTED_DECISIONS.md#id-66-accept-public-invite-requests-without-enumeration)).
The landing form (WP-L1) and the owner "Invite requests" panel (WP-C/WP-L2 UI)
are built separately against the contract below. Design source:
[`design/UI_REDESIGN_SPEC.md`](design/UI_REDESIGN_SPEC.md) §7.2–§7.3.

## Feature flag and capability

| Setting | Effect |
| --- | --- |
| `INVITE_REQUESTS_ENABLED=true` and `CIRCLE_MEMBERSHIP_ENABLED=true` | Enables all three endpoints. Otherwise every endpoint returns `404 {"error":"not found"}`. Default `false`. |
| `/api/auth/capabilities` | Adds `"inviteRequests": true` only when the flag is on, the v21 schema passes the read-only readiness probe, **and** exactly one active primary circle exists. The key is absent otherwise. Show the form only when it is `true`. |
| Owner digest email | Queued only when, in addition, `RESEND_API_KEY`, `RESEND_FROM`, and a canonical HTTPS `APP_URL` are configured in production (local runtime: loopback HTTP capture). |

The isolated local runtime (`npm run dev`) sets `INVITE_REQUESTS_ENABLED=true`.

## Public submission

`POST /api/invite-requests` (rewritten to `/api/invitations?endpoint=invite-requests`)

- No session. The `Origin` header is **required** and must equal the serving
  origin exactly (scheme from `X-Forwarded-Proto` or the socket, host, port;
  no path, query, fragment, or credentials); otherwise
  `403 {"error":"cross-origin request rejected"}`.
- No query parameters other than the rewrite's `endpoint`.
- JSON body, only these keys:

| Field | Rules |
| --- | --- |
| `name` | Required string. Whitespace is collapsed and trimmed, NFC-normalized; 2–60 code points; no control, line-separator, or bidi-override characters. |
| `email` | Required. Printable ASCII only (no spaces, controls, bidi, or Unicode look-alikes; IDN addresses can still be invited directly by the owner), trimmed, lower-cased, at most 254 characters, `local@domain.tld` shape. |
| `note` | Optional string or `null` ("What are you preparing for?"). Trimmed, CRLF→LF, at most 280 code points; empty becomes `null`. Newlines allowed; other controls rejected. |
| `website` | Honeypot. Must be absent, `null`, or empty/whitespace. Render it as a visually hidden input with `tabindex="-1"`, `autocomplete="off"`, `aria-hidden="true"`. |

Responses:

| Status | Body | When |
| --- | --- | --- |
| `202` | `{"ok":true,"message":"Thanks — if the circle has room, you'll get an invitation by email."}` | Accepted. **Identical** (body, headers, ≥750 ms floor) whether the request was stored, the email is already a member, already has a live invitation, already has a pending request, was declined in the last 30 days, or the honeypot was filled. |
| `400` | `{"error":"invalid invite request","fields":{"name"?:string,"email"?:string,"note"?:string,"form"?:string}}` | Field validation. Messages are user-facing; link them with `aria-describedby`. |
| `429` | `{"error":"too many requests; try again later","retry_after_seconds":n}` plus `Retry-After` | 5 per client address per hour (IPv6 keyed by its /64), 3 per email per hour, or the global breaker: 50 **stored** requests in a rolling 24 hours (duplicates, members, invited, declined, and honeypot submissions never count). The breaker is evaluated before anything email-specific, so when it is full every address gets the same 429. UI copy: "Too many requests — try again later." |
| `503` | `{"error":"invite requests unavailable"}` | Schema not ready (before v21), no active primary circle, or a storage failure. |

The client never chooses the circle: requests always target the single active
primary circle.

## Owner review list

`GET /api/invite-requests?status=pending&limit=50&cursor=…`

- Session required (`401`); caller must be an active **owner of the active
  primary circle** (`403 {"error":"primary circle owner required"}`). Recent
  auth is not required.
- `status` optional, only `pending`. `limit` 1–100 (default 50). `cursor` is the
  opaque `next_cursor` from the previous page. Invalid values → `400`.

```json
{
  "ok": true,
  "status": "pending",
  "requests": [
    {"id":"uuid","name":"Ada Lovelace","email":"ada@example.com",
     "note":"System design loops","created_at":"ISO-8601","expires_at":"ISO-8601"}
  ],
  "pending_count": 3,
  "next_cursor": "opaque-or-null"
}
```

Newest first. Requests past `expires_at` (30 days) are never listed or counted.
Render `name` and `note` as text only (never `innerHTML`).

## Owner decision

`POST /api/invite-requests/decision` (rewritten to
`/api/invitations?endpoint=invite-request-decision`)

- Same owner rule as the list; cookie sessions must pass the same-origin
  mutation check (`403`).
- Body exactly `{"id":"<uuid>","decision":"approve"|"decline","expected_status":"pending"}`
  (`400` otherwise).

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | `{"ok":true,"request":{"id","status":"approved","decided_at"},"invitation":{"id","email","expires_at","status":"pending","invite_url":"/invite#invite=…"},"email_delivery":{"queued":bool}}` | Approved. One normal single-use, email-bound invitation was created through the same code path as "invite by email", with its `invitation.created` audit and (when invitation email delivery is configured) the existing `invitation.email.requested` outbox event, delivered right after the response. `invite_url` is returned once so the owner can copy it when email is unavailable. |
| `200` | `{"ok":true,"request":{"id","status":"declined","decided_at"}}` | Declined. Nothing is sent to the requester. |
| `200` | `{"ok":true,"replayed":true,"request":{…},"invitation"?:{"id"}}` | The same decision was already recorded (idempotent retry). No second invitation. |
| `404` | `{"error":"invite request not found"}` | Unknown id, or not a request of a circle the caller owns. |
| `409` | `{"error":"invite request is no longer pending","code":"invite_request_not_pending","status":"approved"|"declined"|"expired"}` | Compare-and-swap failed: a different decision exists or the request expired. Refresh the list. |
| `409` | `{"error":…,"code":"invite_request_already_member"|"invite_request_already_invited","status":"pending"}` | Approval only: the email joined the circle or received a live invitation after requesting (re-checked inside the transaction). No invitation is created; the request stays pending so the owner can decline it. |
| `503` | `{"error":"invite requests unavailable"}` | Storage failure; the approval and its invitation roll back together. |

After approval the invitation appears in `GET /api/invitations` like any other.
Each decision writes a `circle_audit_events` row (`invite_request.approved` with
the invitation id, or `invite_request.declined`) without requester data.

## Owner notification

Outbox event `inviterequest.email.requested`, version 1, payload
`{circle_id, owner_user_id, digest_hour, template_version:1}`; idempotency key
`invite-request-digest/v1/<circle>/<owner>/<hour>`, so each active non-demo
owner receives at most one digest per hour. It is attempted immediately after
the public response (the `waitUntil` path from ID-64) and otherwise by the
outbox cron. At delivery the handler re-reads current state and suppresses when
the owner is no longer an active owner, has email notifications disabled
(`user_notification_prefs.email_enabled=0`), or no live pending request remains.
The email contains only the pending **count** and a dashboard link
(`/?view=circle`); requester names, notes, and addresses are never emailed.

## Data, privacy, and retention

- Table `invite_requests` (migration v21). Pending rows hold the normalized
  email, its HMAC (`email_hash`, same domain as invitations), name, and note.
- Any decision or expiry nulls `email`, `name`, and `note` in the same
  statement (enforced by a table CHECK); decided rows keep only ids, status,
  timestamps, `decided_by`, and `invitation_id`.
- At most one pending row per email (partial unique index). A pending row
  expires after 30 days.
- Opening the owner list scrubs up to 50 overdue pending rows of that circle,
  so contact data does not outlive `expires_at` while waiting for the sweep.
- The weekly cron (`/api/cron/weekly`) runs bounded batches (≤500 rows per
  statement, repeated while work remains, at most 10 batches per run, far
  above the ~350-row weekly maximum intake): overdue pending rows become `expired` (scrubbed) and decided rows
  older than 30 days are deleted. A sweep failure is logged
  (`invite_request_retention_failed`) and never blocks pairing publication.
  Request paths never run unbounded deletes.
- Emails are never logged or sent to Sentry; rate-limit keys are HMACs. If a
  submission outlasts the floor, only `{elapsed_ms, floor_ms}` is logged as
  `[invite_request_floor_exceeded]`.

## Residual risks

- **Intake denial.** An attacker with many addresses and fresh emails can store
  50 requests per rolling day and make the form return 429 for everyone until
  the window rolls. Owners still invite directly, nothing is enumerated, and the
  flag can be turned off; per-/64 keying and stored-only counting raise the
  cost. A CAPTCHA or proof-of-work is the upgrade path if this is observed.
- **Timing.** The 750 ms floor hides normal database latency; outliers past the
  floor are logged so the floor can be raised.

## Rollout and recovery

1. Merge with `INVITE_REQUESTS_ENABLED=false` (default). **Merging deploys
   code that requires v21**: until v21 is applied, `/api/health/ready` returns
   503 (ledger behind the application), production smoke fails, and pairing
   readiness checks that require the exact ledger fail. Apply v21 immediately
   after merge, and never in the hours before the Sunday 08:00 UTC weekly
   pairing run.
2. Apply migration v21 through the protected Turso production migration
   workflow (fresh rehearsal → `status` → `apply` with `target_version=21`)
   right after the merge deploy.
3. Set `INVITE_REQUESTS_ENABLED=true`, redeploy, and confirm capabilities
   report `inviteRequests:true`.
4. Canary: submit a request, confirm the owner digest, approve, and accept the
   invitation.

Recovery: set `INVITE_REQUESTS_ENABLED=false` and redeploy. The endpoints
return 404, the capability disappears, and pending rows still expire through
the weekly sweep. v21 is additive; there is no down migration.
