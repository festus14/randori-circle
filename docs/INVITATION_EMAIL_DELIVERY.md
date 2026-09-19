# Invitation email delivery

Status: bounded issue #95 slice on `codex/increment-35-invitation-email`, stacked
on the schedule-notification candidate PR #96

This slice makes an owner-created invitation useful without requiring the owner
to move the link into another mail client. It intentionally retains the visible
one-time copy-link fallback. Automated tests and the local runtime capture mail
without contacting an external provider; no staging Resend delivery is claimed.

## User and transaction flow

1. An authenticated active primary-circle owner enters an email address.
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

## Event and privacy contract

`invitation.email.requested` event version 1 and template version 1 use:

```text
invitation-email/v1/{invitation-id}/{send-sequence}
```

The invitation table contains only the token hash and email hash. The outbox
payload contains those hashes, stable invitation/circle IDs, sequence/template
versions, and a bounded AES-256-GCM envelope. Its authenticated associated data
binds the envelope to the invitation ID; its plaintext is only the normalized
recipient address and 256-bit invitation token required at delivery time.
Production refuses to queue without a canonical HTTPS `APP_URL`, Resend sender
configuration, and a separate 32-byte base64url
`INVITATION_EMAIL_ENCRYPTION_KEY`. Logs, audit events, status responses, and
dead-letter reasons never include the token, address, rendered body, provider
response, or ciphertext plaintext.

Keep this key stable while invitation events remain actionable. An immediate
uncoordinated rotation makes existing envelopes undecryptable and they will
dead-letter as invalid. A future rotation procedure should add a keyed envelope
version and bounded old-key decrypt window.

## Dispatch suppression and delivery bounds

Before each provider attempt the worker requires:

- the exact event invitation ID, circle ID, token hash, and email hash still
  match the authoritative row;
- the invitation remains unused, unrevoked, and unexpired;
- its primary circle remains unarchived;
- the owner who authorized that exact create/resend event remains a real,
  non-demo, active owner of that circle;
- the invited address has not already acquired a membership in that circle.

Failure of any current-state check becomes terminal `INVITATION_INACTIVE`
suppression. Provider 429 and 5xx failures retain the same idempotency key and
use the shared maximum of five attempts, ten-second provider timeout, bounded
backoff, lease heartbeat, and dead-letter path. A serverless invocation claims
at most three invitation events, bounding this typed slice to 30 seconds of
provider wait.

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
   `RESEND_API_KEY`, `RESEND_FROM`, and `INVITATION_EMAIL_ENCRYPTION_KEY`.
3. Run the authenticated outbox drain at least every five minutes on a platform
   whose function budget supports the configured typed drains.
4. Rehearse create, resend, revoke-before-send, expire-before-send,
   consume-before-retry, and duplicate-worker behavior on a staging Resend
   domain before claiming live delivery.

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
- Issue #50 remains open for SMS consent/verified-number policy, quiet hours,
  regional requirements, provider/STOP handling, and any product-chosen extra
  reminder cadence.
- Issue #94 tracks a shared deadline/claim budget (or separate schedules) for
  the sequential pairing, schedule, invitation, activation, and reset drains.
