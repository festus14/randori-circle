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
| `agree_time` | 72 hours after the current cycle's pairing was published, until the cycle ends | Every member of a non-AI, non-solo pair with no agreed time, when every member is still an active, real member | Primary: `/join/<room>`; secondary: `/?view=dashboard` | A time was agreed, the cycle ended (`CYCLE_ENDED`), the recipient left (`MEMBER_REMOVED`), a partner left or became demo (`PARTNER_REVOKED`), or email is off |
| `session_soon` | Between 65 and 15 minutes before an agreed session; `not_before` is one hour before it | Every member of the pair, under the same all-members rule | Primary: `/join/<room>`; secondary: `/?view=dashboard` | The time was cleared or changed, the session started (`SESSION_ELAPSED`) or is under 15 minutes away (`SESSION_IMMINENT`), the recipient or a partner left, email is off, or `REMINDERS_SESSION_SOON_ENABLED` is off |

The existing accepted-session reminder 24 hours ahead
([schedule notifications](SCHEDULE_NOTIFICATIONS.md)) is unchanged; the
one-hour reminder is an addition. Its subject is "Your Randori session starts
soon" and the body gives the exact time, so a reminder sent between 15 and 65
minutes ahead is never wrong about the lead.

Primary schedules are not tied to the pairing cycle: a pair from week 38 can
agree a time on Sunday after the 08:00 boundary into week 39. The one-hour
reminder therefore relies only on the agreed-time fingerprint and the elapsed
and 15-minute checks, never on `CYCLE_ENDED`, and its due-check reads pairs of
the current and the previous week. Only the nudge, which is about this cycle's
pairing, ends with the cycle. Secondary schedules belong to their publication
and, like the secondary 24-hour reminder, are only reminded while it is current.

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

The badges show the account's confirmed preference: they change only after a
save succeeds and stay as they were if it fails.

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
  reminder-email/v1/availability-cutoff/{circle|local}/{cycleKey}/{user}
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
  queued. `session_soon` keys hold a fingerprint computed in JavaScript, so
  queued keys are filtered after each read: the read pages with a keyset on
  (agreed time, group, user), earliest session first, until 50 new reminders
  are found or the window runs out, so already-queued recipients can never
  hide later ones. Each run reads at most 20 pages (1,000 rows); if that cap
  stops the scan early the count is still reported and
  `reminder_errors.session_soon` is `PAGE_LIMIT_REACHED`. No new Vercel cron
  was added.
- Kinds run in the order `session_soon`, `agree_time`, `availability_cutoff`
  and fail independently. A failing kind reports a bounded error code (the
  libSQL code such as `SQLITE_BUSY`, otherwise `QUERY_FAILED`) in
  `outbox.reminder_errors` and a `null` count in `outbox.reminders_enqueued`;
  the other kinds still run. The whole check has its own 5-second slice of the
  preparation window (`DUE_CHECK_TIMEOUT`, or `DUE_CHECK_FAILED` for an
  unusable client). Nothing is queued when no reminder handler can deliver (no
  Resend keys and no local capture): `due_check` is then
  `NO_DELIVERY_HANDLER`, so intents never sit pending undeliverable. Any
  reminder error logs the `outbox_invocation` row at `warn` level, and other
  mail is still delivered.
- Cost per five-minute run: one lookup of the current and previous primary
  week (`pairing_weeks` by label joined to its run). The one-hour query is
  fully indexed (`pair_schedules` by week, groups by id). The nudge query runs
  only from 72 hours after publication until the cycle ends (about 1,150 runs
  a week); `pairing_groups` has no `week_id` index, so each of those runs
  scans every stored group once (the pairs CTE is `MATERIALIZED`, so not once
  per member slot). At current circle sizes that is hundreds of rows per run,
  well inside Turso's read allowance. An hourly throttle would need persisted
  state and an index needs a migration, so neither was added.
- Local runtime: reminders read availability under the same scope the
  availability endpoint writes. The bundled dev server enables circle
  membership, so that is the primary circle's `circle:{id}` scope, as in
  production (the golden path saves a choice in the browser and checks that it
  stops the cutoff reminder). A strict local runtime with membership disabled
  uses the `local` scope and skips membership checks; the endpoint, the
  pairing publisher and reminders share one check for that
  (`strictLocalPairingRuntime` in `api/_local-runtime.js`).

## Known limits

- All three kinds share one fair-dispatch lane (one claim per round), so a
  large backlog of one kind can delay the others by a few rounds. This only
  matters for large circles and is left as is.
- Re-enabling `REMINDERS_ENABLED` mid-cycle does not resend reminders that
  were drained as `suppressed` (`REMINDERS_DISABLED`) while it was off: their
  idempotency keys already exist. New reminders queue normally.
- The one-hour reminder is opt-in per deployment, not per member (see
  Preferences); `REMINDERS_SESSION_SOON_ENABLED` stays off until per-type
  toggles exist.
- Primary pairs from two or more cycles back get no one-hour reminder, even
  though a past week's room can still set a future time; only the current and
  previous week are read.
- Secondary sessions after their publication's boundary are not reminded,
  matching the existing secondary 24-hour reminder.

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
  cutoff instant, October and March DST changes), 72-hour nudge boundary and
  the early return before it, one-hour window and 15-minute minimum, sessions
  after the Sunday boundary, more than 200 recipients in one window (keyset
  paging), earliest-session ordering, the per-run page cap, partner removal
  for primary and secondary pairs,
  timezone display, secondary circles, the local availability scope, per-kind
  failure isolation and order, send-time suppression reasons, idempotency
  across retries and replay, provider error classification.
- `tests/unit/reminders-ops.test.mjs`: preferences response with the flag off
  and on, the cron due-check queuing and delivering in one invocation, a
  failing kind logged at `warn` while queued mail is delivered, no queueing
  without a delivery handler, the due-check timeout, and a guard that every
  outbox type keeps a claim under the cap.
- `tests/e2e/ui-shell-accessibility.spec.ts`: reminder badges follow only the
  confirmed preference.
- `tests/e2e/golden-reminders-real-runtime.spec.ts`: the real-runtime golden
  path ([matrix row 14](testing/E2E_GOLDEN_PATHS.md)).
