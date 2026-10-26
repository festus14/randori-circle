# Email not arriving

A member reports mail never arrived, or dead letters are growing. The
descriptive layer is [SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md) §5.1
(outbox lifecycle) and the §8 failure-mode table. Outbox mail is the
only email path: every mail type is one durable `outbox_events` row,
delivered by the outbox worker.

## Symptoms

- One member gets no invitation, activation, password-reset, pairing,
  or reminder mail.
- Many members get no mail, or mail arrives hours late.
- The outbox watchdog alerts `delivery_stale`.

First establish scope: one recipient and one mail type, or everything.
One recipient is usually the provider, the address, or the inbox;
everything is usually the scheduler, a flag, or the sender domain.

## Confirm (read-only)

Outbox health needs a scheduler secret (`OUTBOX_DISPATCH_SECRET` or
`CRON_SECRET`, from the password manager — never paste a secret into a
command history you share). It returns aggregates only, never payloads
or recipients:

```bash
curl -s https://randoricircle.com/api/cron/outbox-health \
  -H "Authorization: Bearer $OUTBOX_DISPATCH_SECRET"
```

Read `dueCount`, `oldestDueAgeMs`, `deadLetterCount`,
`lastDeliveredAt`, and `recentRejectReasons` (dead letters in the last
24 h grouped by bounded provider reason):

| Field | Meaning |
| --- | --- |
| `dueCount` > 0 and growing, `oldestDueAgeMs` over 15 minutes | Mail is not draining — see [scheduler stopped](scheduler-stopped.md) |
| `deadLetterCount` > 0 with a provider reason | The provider refused those sends — see the reason table below |
| `dueCount` is 0, `lastDeliveredAt` is recent, one recipient complains | The mail left Randori; check the provider and the inbox |

Then, signed in as an admin, read the Diagnostics dead-letters card
(`GET /api/admin/diagnostics`): per dead letter, its event type,
provider reason, attempt count, and whether retention already removed
its recipient details (`redacted: true`).

Provider reasons recorded on dead letters (`status:name:reason`,
PII-free):

| Reason | Meaning | Action |
| --- | --- | --- |
| `domain_not_verified` | The sender domain is not verified in Resend | See [domain/DNS](domain-dns.md) |
| `testing_recipient_restricted` | The `onboarding@resend.dev` test sender delivers only to the Resend account owner's own address | Use a verified-domain `RESEND_FROM`, not the test sender |
| `api_key_invalid` / `api_key_missing` / `api_key_restricted` | The Resend key is wrong, absent, or restricted | Rotate `RESEND_API_KEY` — see [rotating secrets](rotating-secrets.md) |
| `quota_exceeded` / `rate_limited` | Resend quota or rate limit | Wait, then replay; check the Resend dashboard |
| `invalid_from_address` | `RESEND_FROM` is malformed or not on a verified domain | Fix `RESEND_FROM` in Vercel and redeploy |
| `invalid_recipient` | The recipient address is malformed or rejected | Confirm the address with the member; do not retry blindly |
| `missing_required_field` | A required field was missing from the send request | Check the Resend dashboard logs for the missing field; do not replay blindly — the send request itself was malformed |
| `idempotency_conflict` / `other` | Provider-side conflict or unclassified refusal | Check the Resend dashboard logs |

Also check, in order:

1. **Is the mail type's flag on?** While a flag that gates an event
   type is off, its handler is not registered and queued rows stay
   `pending` — they are held mail, not lost mail. See
   [feature flags](feature-flags.md).
2. **Resend dashboard:** Domains shows the sender domain as Verified
   or not; Logs/Emails shows delivery, bounce, and refusal per send.
3. **The inbox:** spam/junk, filters, and a mistyped address. Randori
   aggregates never expose recipient addresses; confirm the address
   with the member directly.

## Fix

- **Scheduler stopped:** [scheduler stopped](scheduler-stopped.md).
  Held mail drains once the scheduler runs again.
- **Flag off:** turn the flag back on and redeploy. Held rows are
  then sent, or suppressed if they are no longer valid (e.g. the
  link expired).
- **Sender domain unverified:** [domain/DNS](domain-dns.md).
- **Dead letter, cause fixed:** replay it from admin Diagnostics.
  **Destructive:** replaying re-sends a real email. Use one reason
  code — `OPERATOR_RETRY`, `PROVIDER_RECOVERED`, or
  `CONFIGURATION_FIXED` — via `POST /api/admin/outbox/replay` as an
  admin. A dead letter whose recipient details were removed by PII
  retention (delivered/suppressed rows after 7 days, dead letters
  after 30 days) returns 409 and can never be replayed.
- **Expired link:** activation and password-reset links expire after
  30 minutes; invitations after 7 days, with a 5-send cap. Replaying
  an expired link does not help — the member must request a fresh
  one (activation resend, password-reset request, or a new invitation).

Do not replay the same dead letter repeatedly, and do not replay a
dead letter whose cause is not fixed: it will dead-letter again.

## Verify

```bash
curl -s https://randoricircle.com/api/cron/outbox-health \
  -H "Authorization: Bearer $OUTBOX_DISPATCH_SECRET"
# Expect dueCount falling, oldestDueAgeMs under 15 minutes,
# lastDeliveredAt advancing.
```

Confirm the next hourly outbox watchdog run is green, and confirm
with the affected member that a fresh mail arrived.
