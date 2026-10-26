# Turning feature flags on and off

The full flag table — what each flag gates, its production state,
dependencies, and what turning it off does — is the
[Feature flags section](../ENVIRONMENT.md#feature-flags) in
[ENVIRONMENT.md](../ENVIRONMENT.md). That table is the source of
truth; this runbook does not duplicate it. The descriptive layer is
[SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md) §6.

## Rules

- A `*_ENABLED` flag is on only for the exact string `true`.
  Anything else — `1`, `TRUE`, unset — means off. The one exception
  is `OUTBOX_IMMEDIATE_DELIVERY`, a three-state switch (normally
  unset, which means on when `VERCEL=1`).
- Change a flag in Vercel Production, then redeploy. Vercel reads
  variables only at build/deploy time, so a flag change has no effect
  until the redeploy finishes.
- Operator gates are not product flags:
  `TURSO_PRODUCTION_MIGRATIONS_ENABLED`,
  `CREDENTIAL_KEY_CONTROL_MUTATIONS_ENABLED`,
  `CHAT_RETENTION_ENABLED`, `CHAT_RETENTION_LOCAL_ADOPTION`. Keep
  each one `false` except during one approved operation, then set it
  back immediately. Turning them off is always safe; `status` still
  works.
- `EXECUTION_PROVIDER` is not a boolean but is the switch for Run:
  unsetting it makes every run fail closed with
  `execution_unavailable` and changes no data.

## Turning a flag on

1. Check the flag's row in the
   [flag table](../ENVIRONMENT.md#feature-flags): dependencies
   (migration version, key-control acceptance, another flag),
   and what it gates.
2. Confirm the dependencies are green: the migration is applied
   ([schema migration cutover](schema-migration-cutover.md)), the
   key control is accepted ([KEY_ROTATION.md](../KEY_ROTATION.md)),
   and the parent flag is on (secondary-circle flags need the
   multi-circle control plane; reminder and session-soon flags need
   their parents).
3. Set the flag to `true` in Vercel Production and redeploy.
4. Verify capabilities advertise the feature (see Verify below).

## Turning a flag off

1. Read the flag's "Turning it off safely" column first. In most
   cases turning a flag off is safe: endpoints hide, writes stop, and
   rows are kept — nothing stored is deleted.
2. **Held mail.** While `EMAIL_PASSWORD_ACTIVATION_ENABLED`,
   `PASSWORD_RESET_ENABLED`, `INVITATION_EMAIL_DELIVERY_ENABLED`,
   or `INVITE_REQUESTS_ENABLED` is off, that type's outbox handler is
   not registered and queued rows stay `pending`. Once the oldest
   held row is over 15 minutes old, the outbox watchdog reports
   `delivery_stale`. Either expect that alert, or turn the flag off
   only when the queue is empty: `dueCount` from
   `/api/cron/outbox-health` is `0`, or the type's Due column in
   admin Diagnostics is `0`. Reminders and feedback do not have this
   problem: their handlers stay registered, so queued rows drain as
   `suppressed` while their flags are off.
3. Set the flag to `false` (or unset it) in Vercel Production and
   redeploy.

## Irreversible flags

Two flags have effects that turning them off cannot undo:

- **`ACCOUNT_DELETION_ENABLED`.** Turning it off hides the endpoint
  and UI. **Irreversible:** accounts already deleted stay deleted
  (tombstoned); nothing is restored by switching the flag off.
- **`OUTBOX_PII_RETENTION_ENABLED`.** Turning it off stops further
  redaction. **Irreversible:** redacted rows cannot be restored,
  and redacted dead letters stay non-replayable.

Two more non-reversals to know:

- **`CIRCLE_MEMBERSHIP_ENABLED` off does not reopen registration**
  once the cutover latch has closed. It restores legacy roster
  behaviour and switches off everything that depends on it. Avoid in
  production.
- **Multi-circle archive markers:** never clear an archive marker as
  a rollback.

## Verify

```bash
curl -s https://randoricircle.com/api/auth/capabilities
# Expect the capability for the flag to appear (on) or disappear
# (off) after the redeploy.
```

Confirm the production smoke check is green, and for email-gating
flags confirm `/api/cron/outbox-health` shows no held mail ageing
past 15 minutes.
