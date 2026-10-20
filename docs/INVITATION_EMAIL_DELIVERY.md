# Invitation email delivery

Status: bounded issue #95 slice consolidated into
[PR #96](https://github.com/festus14/randori-circle/pull/96)

This slice makes an owner-created invitation useful without requiring the owner
to move the link into another mail client. It intentionally retains the visible
one-time copy-link fallback. Automated tests and the local runtime capture mail
without contacting an external provider; no staging Resend delivery is claimed.

## User and transaction flow

1. An authenticated owner of the active selected circle enters an email address.
2. Randori creates a seven-day, email-bound invitation. With complete delivery
   configuration, the invitation, audit record, and versioned email event commit
   in one write transaction. Any outbox failure rolls back all three.
3. The response always includes the manual copy link. It separately reports
   whether email was queued, so incomplete provider/encryption configuration
   does not destroy the manual fallback.
4. The worker claims the event, revalidates current state, and sends through the
   provider adapter with the outbox idempotency key.
5. An owner may explicitly resend after 60 seconds. Resend rotates the bearer
   token and atomically records the new event and audit row. Every older link
   and stale queued attempt then fails preparation or suppresses at dispatch.

Resend is limited to five total sends per invitation, including creation. An
invitation created while email was unconfigured has no recoverable recipient or
token in the outbox, so it cannot later be emailed: the UI preserves the copied
link and the owner may create a new invitation after configuration is repaired.

## Inviting several people at once (ID-68)

The Circle invite card has an **Invite several people at once** disclosure. The
owner pastes addresses separated by commas, semicolons, spaces, tabs or new
lines; `Name <email>` and `"Last, First" <email>` (Gmail, Outlook, Sheets
copies) contribute only the bracketed address, and `mailto:` prefixes and
wrapping quotes or brackets are dropped. The preview de-duplicates after
normalisation, marks each address **Ready** or **Fix** (with the reason), and
blocks the button above 50 valid addresses. Only valid, unique addresses are
sent. After the request each address gets one result row: **Invited · Copy
link**, **Already a member** (or **Former member** for an inactive one),
**Already invited · Resend**, **Invalid · reason**, or **Failed · Retry**.
Invalid and failed addresses stay in the textarea so the owner can fix them and
send again; everything else is removed. Links and addresses live only in tab
memory and are cleared on any identity or circle change.

### API contract

`POST /api/invitations` keeps the single `{email}` contract and also accepts
`{emails:[...]}` (exact key, 1–50 entries; `BULK_INVITE_MAX` in
`assets/email-validation.js`). Same-origin and owner rules are the single
path's (`verifyMutationOrigin`, `ownerContext`, active-circle context version).
No new route or rewrite exists, so `vercel.json` and the local server are
unchanged.

| Response | When |
| --- | --- |
| `400 {code:'bulk_invite_invalid'}` | `emails` is not a non-empty array |
| `400 {code:'bulk_invite_too_many', max:50}` | more than 50 entries (checked before authentication work) |
| `401` / `403` / `409 circle_context_changed` | as for a single invitation; 403/409 are also returned when nothing could be created because ownership or the context changed |
| `429 {code:'invitation_quota_exceeded', retry_after_seconds, remaining, limit}` + `Retry-After` | the batch needs more invitations than the circle has left today (nothing is created) |
| `503 {error:'invitations unavailable'}` | the read-only classification step failed |
| `200 {ok, results, summary, max, email_delivery:{queued:N}}` | otherwise, even if every entry is invalid |

`results[i]` is in input order: `{index, input, email, status, ...}` where
`input` echoes the submitted string (≤320 characters, `null` for non-strings)
and `email` is the canonical address. Statuses:

- `created` — `invitation` has exactly the single-path fields (`id`, `email`,
  `expires_at`, `status:'pending'`, `invite_url`) plus `email_delivery.queued`.
- `invalid` — `reason` is a validator code (below).
- `duplicate_in_request` — `duplicate_of` is the index of the first occurrence.
- `already_member` — `member_status` is `active` or `inactive`.
- `already_invited` — `invitation:{id,status:'pending'}` of the newest live
  invitation, so the UI can call the existing resend endpoint.
- `failed` — `reason` is `unavailable`, `rate_limited` (with
  `retry_after_seconds`), `owner_required`, or `circle_context_changed`.

`summary` counts every status. Owners already see their members and
invitations, so these statuses reveal nothing new to them; the endpoint never
puts an address or input in logs or Sentry (tags only).

### Transactions, quota, and delivery

Classification (validation, de-duplication, membership and live-invitation
lookups for the selected circle) is read-only. Each remaining address then gets
**its own write transaction** running the same steps as a single invitation:
email readiness, circle-context check, quota reservation,
`insertOwnerInvitation` (invitation + `invitation.created` audit row + outbox
event `invitation-email/v1/{id}/1`), commit. A failure rolls back only that
address; it is reported as `failed` and the batch continues. Losing ownership,
a context change, or an exhausted quota stops the rest of the batch (reported
per address). Per-address transactions were chosen over one transaction so a
single bad row or lock timeout cannot discard valid invitations.

Owner-created invitations (single and bulk) share a fixed-window quota of
**200 per circle per 24 hours** in `auth_rate_limits` (HMAC key
`randori-invitation-create-circle-v1`). A bulk request first checks the
remaining quota and returns 429 if the batch does not fit; each transaction then
reserves one slot with a conditional upsert that never over-consumes, and a
rollback refunds it. Approving an invite request does not use this quota (it is
bounded by the invite-request limits).

After the response, the created events go to the existing post-commit attempt
(ID-64), which delivers at most 8 events per request inside its time budget.
The rest stay pending in the outbox and are sent by the next scheduled
`/api/cron/outbox` run, so in a large batch some emails can take until that run.
The copy links are available immediately either way.

### Shared email validation

`assets/email-validation.js` is one dependency-free ES module imported by the
API and loaded by the browser (`<script type="module">`), so client and server
rules cannot drift. Canonical form is `trim()` + `toLowerCase()`, exactly as
before. An address is valid when it is at most 254 characters, has exactly one
`@`, a local part of 1–64 `` [a-z0-9.!#$%&'*+/=?^_`{|}~-] `` without leading,
trailing or consecutive dots, and a domain of at least two labels of 1–63
`[a-z0-9-]` that do not start or end with `-`, ending in an alphabetic TLD of 2+
letters or an `xn--` punycode label. Whitespace, control, zero-width, bidi and
any other non-ASCII characters are rejected (international domains must be
entered as punycode). Reason codes: `invalid_type`, `empty`,
`invalid_characters`, `too_long`, `non_ascii`, `missing_at`, `multiple_at`,
`local_empty`, `local_too_long`, `local_invalid`, `local_dots`,
`domain_missing`, `domain_no_dot`, `domain_empty_label`,
`domain_label_too_long`, `domain_invalid`, `domain_hyphen`, `tld_invalid`.

The strict rules apply wherever a **new** address enters the system: owner
invitations (single, bulk, and `insertOwnerInvitation`), invite-request intake,
and password sign-up. Paths that look up an address already on record — sign-in,
password reset, activation resend, Google identity, invitation acceptance and
outbox decoding — keep `normalizeInvitationEmail` (same canonical form, the
original loose shape check), so no existing account or pending invitation is
locked out. An invite request stored before these rules whose address now fails
them cannot be approved (`409 invite_request_email_invalid`); the owner can
decline it. In the browser, the single invite form, the bulk form, the sign-up
dialog and the landing request form show the validator's message inline;
sign-in and reset deliberately do not.

## Event and privacy contract

`invitation.email.requested` event version 1 and template version 1 use:

```text
invitation-email/v1/{invitation-id}/{send-sequence}
```

The invitation table contains only the token hash and email hash. The outbox
payload contains those hashes, stable invitation/circle IDs, sequence/template
versions, and a bounded AES-256-GCM envelope. V2 authenticated associated data
binds the purpose, envelope version, key version, and exact event idempotency
key; legacy v1 remains readable during the staged rollout and binds the
invitation ID. Envelope plaintext is only the normalized
recipient address and 256-bit invitation token required at delivery time.
Production refuses to queue without a canonical HTTPS `APP_URL`, Resend sender
configuration, and a separate 32-byte base64url
`INVITATION_EMAIL_ENCRYPTION_KEY`. It also requires the exact production gate
`INVITATION_EMAIL_DELIVERY_ENABLED=true`; merely provisioning secrets cannot
start sending mail. The isolated local runtime continues to use local capture
without that production gate. Logs, audit events, status responses, and
dead-letter reasons never include the token, address, rendered body, provider
response, or ciphertext plaintext.

Rotate this key only through the bounded prior-key window in
`KEY_ROTATION.md`. Unknown or temporarily absent versions retry, while malformed,
tampered, and cross-event-replayed v2 envelopes are terminal invalid data.

## Dispatch suppression and delivery bounds

Before each provider attempt the worker requires:

- the exact event invitation ID, circle ID, token hash, and email hash still
  match the authoritative row;
- the invitation remains unused, unrevoked, and unexpired;
- its exact circle remains unarchived, including a selected non-primary circle;
- the owner who authorized that exact create/resend event remains a real,
  non-demo, active owner of that circle;
- the invited address has not already acquired a membership in that circle.

Failure of any current-state check becomes terminal `INVITATION_INACTIVE`
suppression. Provider 429 and 5xx failures retain the same idempotency key and
use the shared maximum of five attempts, ten-second provider timeout, bounded
backoff, lease heartbeat, and dead-letter path. The shared dispatcher admits
invitation work in fair one-per-type rounds under the aggregate eight-claim,
45-second invocation budget.

Owner create/resend remains same-origin and owner-authorized. The public
preparation endpoint continues to use one generic invalid response, a durable
caller rate limit, a fragment credential that never reaches the HTTP request
URL, and a short-lived HttpOnly claim cookie.

## Deployment

No migration is added. Schema v6 already provides the provider-neutral outbox;
the existing invitation model provides current truth. Migration v9 remains
reserved for issue #83.

Before production delivery:

1. Complete the existing v6/v7 protected migration and readiness process.
2. Configure `CIRCLE_MEMBERSHIP_ENABLED=true`, canonical HTTPS `APP_URL`,
   `RESEND_API_KEY`, `RESEND_FROM`, and `INVITATION_EMAIL_ENCRYPTION_KEY` while
   leaving `INVITATION_EMAIL_DELIVERY_ENABLED=false`.
3. Run the authenticated outbox drain at least every five minutes on a platform
   whose function budget supports the configured typed drains.
4. Set `INVITATION_EMAIL_DELIVERY_ENABLED=true` in staging and rehearse create,
   resend, revoke-before-send, expire-before-send,
   consume-before-retry, and duplicate-worker behavior on a staging Resend
   domain before enabling the same gate in production or claiming live delivery.

## Alternatives considered

| Option | Advantage | Cost and decision |
| --- | --- | --- |
| Keep manual copy only | No mail secret or worker | Makes the core owner workflow need another tool; retained only as fallback |
| Send synchronously | Immediate provider result | Couples latency/failure to creation and can lose delivery after commit; rejected |
| Store plaintext token/address | Simplest worker | A database read exposes live credentials and personal data; rejected |
| Store only hashes | Minimum disclosure | Cannot deliver later; hashes plus an authenticated encrypted envelope chosen |
| Reuse JWT or activation key | Fewer secrets | Expands blast radius and couples unrelated rotations; rejected |
| Separate invitation queue | Domain-specific columns | Duplicates v6 leases, retries, metrics, replay, and audit; rejected |
| Never rotate on resend | Old email remains valid | Cannot suppress compromised or stale links; rejected |

## Explicit remaining scope

- Issue #95 remains open until the templates and all suppression paths are
  validated through a real staging Resend domain with owned credentials and
  sender configuration.
- Issue #50 still requires the staging Resend journey and any product-chosen
  extra reminder cadence. SMS is explicitly outside that issue and remains
  separate future work.
- Issue #94's shared deadline and fair claim budget now includes password reset
  in the single five-type registry and is covered by a mixed real-database
  saturation regression.
