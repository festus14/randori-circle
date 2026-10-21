# Reminders: availability cutoff, agree-a-time nudge, one-hour reminder

Issue: [#287](https://github.com/festus14/randori-circle/issues/287) (roadmap
[#312](https://github.com/festus14/randori-circle/issues/312), Wave 1)
Decision: [ID-71](IMPLEMENTED_DECISIONS.md#id-71-send-reminders-from-the-outbox-cron-behind-a-flag-without-a-migration)
Status: implemented behind `REMINDERS_ENABLED` (default off). No migration.
Final email and settings design is pending (`needs-design`).

## What is sent

| Kind | When it is queued | Recipients | Link | Suppressed at send when |
| --- | --- | --- | --- | --- |
| `availability_cutoff` | From 24 hours before the upcoming cycle cutoff (Sunday 08:00 in `PAIRING_TIME_ZONE`) until the cutoff | Active, non-demo members of the primary circle (and of secondary circles when `MULTI_CIRCLE_AVAILABILITY_ENABLED`) with no explicit (`source: user`) decision for that cycle | `/?view=pair` | A decision was saved, the cutoff passed (the upcoming cycle key changed), the member left, the account became demo, or email is off |
| `agree_time` | 72 hours after the current cycle's pairing was published, until the cycle ends | Every human member of a non-AI, non-solo pair with no agreed time | Primary: `/join/<room>`; secondary: `/?view=dashboard` | A time was agreed, the cycle ended, the recipient or partner left, or email is off |
| `session_soon` | Up to 65 minutes before an agreed session; `not_before` is one hour before it | Every human member of the pair | Primary: `/join/<room>`; secondary: `/?view=dashboard` | The time was cleared or changed, the session started, a member left, email is off, or `REMINDERS_SESSION_SOON_ENABLED` is off |

The existing accepted-session reminder 24 hours ahead
([schedule notifications](SCHEDULE_NOTIFICATIONS.md)) is unchanged; the
one-hour reminder is an addition.

Times in the email are shown in the recipient's profile timezone
(`auth_accounts.tz`) with the zone name, falling back to UTC when it is unset
or invalid. Each email says reminders can arrive a few minutes late; the
outbox cron runs every five minutes (ID-67), with GitHub as a slower backup.

## Flags

| Variable | Default | Effect |
| --- | --- | --- |
| `REMINDERS_ENABLED` | unset (off) | Enables the due-check in `/api/cron/outbox`, delivery of queued reminders, and the `reminders` object in `GET /api/notifications/prefs`. While off, the due-check makes no database query and queued reminders drain as `suppressed` (`REMINDERS_DISABLED`). |
| `REMINDERS_SESSION_SOON_ENABLED` | unset (off) | Also queues and sends the one-hour reminder. Has no effect unless `REMINDERS_ENABLED=true`. |

Merging changes nothing for users: both flags are unset in production.

## Preferences

Every reminder follows the existing `user_notification_prefs.email_enabled`
preference (default on), checked when the reminder is queued and again before
the provider is called. While the flag is on, the email reminder row under
notification preferences lists the reminder types it covers and shows them as
On or Off with the Email checkbox.

Per-type toggles (issue default: on, on, off) are **deferred**. They need new
columns or a table, and any migration makes `/api/health/ready` fail until it
is applied in production (see the v21 rollout in
[invite requests](INVITE_REQUESTS.md#rollout-and-recovery)), which would make
this merge visible. Until then the one-hour reminder is opt-in for the whole
deployment through `REMINDERS_SESSION_SOON_ENABLED`, not per member.

## Outbox contract

- One event type, `reminder.email.requested` v1, with template version 1. The
  fair dispatcher now has seven types, still below the eight-claim cap, so
  every type keeps a first-round claim ([budget](OUTBOX_INVOCATION_BUDGET.md)).
- Payloads hold only identifiers: kind, circle or week/pair or
  publication/group ids, the availability cycle key, the recipient user id,
  and for `session_soon` a SHA-256 fingerprint of the agreed instant. No
  address, name, link, or instant is stored.
- Idempotency keys are stable and are also the provider idempotency key:

  ```text
  reminder-email/v1/availability-cutoff/{circle}/{cycleKey}/{user}
  reminder-email/v1/agree-time/primary/{week}/{pair}/{user}
  reminder-email/v1/agree-time/secondary/{publication}/{group}/{user}
  reminder-email/v1/session-soon/{primary|secondary}/{week|publication}/{pair|group}/{fingerprint}/{user}
  ```

  A rescheduled session gets a new key; the old one is suppressed as
  `SESSION_CHANGED`. Retries, lease recovery, and dead-letter replay reuse the
  original key.
- Provider errors use the shared classification (`PROVIDER_RATE_LIMITED`,
  `PROVIDER_UNAVAILABLE`, `PROVIDER_REJECTED`, `PROVIDER_FAILED`) with the
  bounded `status:name:reason` audit reason from `_email-provider-reason.js`.
- The due-check runs inside the timeboxed preparation step of
  `/api/cron/outbox`, before the claim rounds, so a newly due reminder can be
  delivered in the same invocation. It creates at most 50 intents per kind per
  invocation and is skipped by `NOT EXISTS` on the idempotency key once
  queued. It has its own 5-second slice of the preparation window; a failure
  or timeout is reported as `outbox.reminders_enqueued: null` and does not
  block other mail. No new Vercel cron was added.

## Volume

At most one cutoff reminder per member per week, one nudge per member per
cycle, and one one-hour reminder per member per agreed session. For a circle of
20 members that is under 60 emails a week, well inside the Resend free tier
(3,000 a month, 100 a day).

## Rollout and recovery

1. Merge with both flags unset. Nothing changes.
2. Optional staging rehearsal: set `REMINDERS_ENABLED=true` on a non-production
   deployment and check the captured mail.
3. Owner decision: set `REMINDERS_ENABLED=true` in Vercel Production and
   redeploy. Watch `outbox.reminders_enqueued` and the
   `reminder.email.requested` counts in the cron response and
   `/api/cron/outbox-health`.
4. Optionally set `REMINDERS_SESSION_SOON_ENABLED=true` later.

Recovery: unset `REMINDERS_ENABLED` and redeploy. Queued reminders drain as
`suppressed` on the next cron run; nothing else is affected.

## Verification

- `tests/unit/reminders.test.mjs`: cycle-boundary timing (24-hour window,
  cutoff instant, October DST change), 72-hour nudge boundary, one-hour window,
  timezone display, secondary circles, send-time suppression reasons,
  idempotency across retries and replay, provider error classification.
- `tests/unit/reminders-ops.test.mjs`: preferences response with the flag off
  and on, and the cron due-check queuing and delivering in one invocation.
- `tests/e2e/golden-reminders-real-runtime.spec.ts`: the real-runtime golden
  path ([matrix row 14](testing/E2E_GOLDEN_PATHS.md)).
