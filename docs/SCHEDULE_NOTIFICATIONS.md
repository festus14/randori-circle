# Schedule email notifications

Status: implemented in consolidated
[PR #96](https://github.com/festus14/randori-circle/pull/96) on the current
release stack

This document describes the primary-room `schedule.email.requested` v1
contract. Secondary-circle scheduling reuses the same event type as v2 under a
separate flag; see `SECONDARY_SCHEDULE_NOTIFICATIONS.md`. This slice sends
durable email notifications for schedule proposals, accepted times, changed or
cleared agreements, and accepted-session reminders. Owner
invitation-link delivery is consolidated into the same candidate. A live
staging-provider rehearsal remains outstanding, so this work does not yet close
issue #50. SMS is explicitly outside issue #50 and is separate future work.

## Event and transaction contract

Schedule mutations keep their existing optimistic `base_version` contract. A
successful schedule write and every resulting `schedule.email.requested` v1
event are committed in one libSQL write transaction. If any event insert fails,
the schedule write rolls back. A stale compare-and-swap commits neither the
schedule nor notification work.

The primary event uses template version 1 and an idempotency key with this shape:

```text
schedule-email/v1/{week}/{pair}/{kind}/{schedule-version}/{recipient-user}
```

The payload contains only the event kind, stable database identifiers, current
and previous instants, schedule version, and template version. It deliberately
does not contain an email address, bearer token, invitation link, message body,
or display name. The worker resolves those values at dispatch time. The shared
outbox limits each event to five attempts and a ten-second provider timeout.
The shared serverless drain admits schedule work in one-per-type fair rounds;
all types together are capped at eight claims and one 45-second deadline.
Both schedule event versions occupy this one schedule lane.

| Mutation | Immediate email | Delayed email | Recipients |
| --- | --- | --- | --- |
| Add proposal | Proposal | None | Other human pair members |
| Accept first time | Accepted | 24-hour reminder | Every human pair member |
| Accept a different time | Changed | Replacement 24-hour reminder | Every human pair member |
| Clear agreement | Changed/cleared | None | Every human pair member |
| Remove proposal | None | None | None |

If an agreed time is less than 24 hours away, its reminder is immediately due.
If delivery is attempted after the session starts, it is suppressed.

## Dispatch safety

Immediately before provider delivery the handler re-checks all of the
following against current database state:

- the actor and recipient are still real, source-tagged participants in the
  exact pair room;
- in production, both accounts still have active membership in the unarchived
  primary circle;
- the account is real, non-demo, and still has a valid email address;
- email notifications are not disabled in `user_notification_prefs`;
- a proposal still exists, an agreement still has the queued instant, or the
  agreement remains cleared;
- no newer event supersedes the same proposal, agreement notice, or reminder:
  accepting or changing to the exact proposed instant suppresses an undelivered
  proposal, including a reschedule and an A-to-B-to-A cycle;
- the scheduled instant has not elapsed.

This makes removed proposals, revoked members, changed preferences, cleared
agreements, and replaced reminders terminal `suppressed` outcomes instead of
provider sends. Provider 429 and 5xx failures use the existing bounded retry
and dead-letter behavior. Provider responses retain the original idempotency
key across crash recovery. Application logs contain aggregate counts and reason
codes, not addresses or rendered bodies.

The local runtime and tests use an in-memory capture adapter. Production keeps
the existing Resend adapter behind `RESEND_API_KEY` and `RESEND_FROM`; missing
configuration leaves work pending and exposes only aggregate status.

`/api/cron/outbox` has one 45-second deadline, eight-claim cap, and fair
parallel claim rounds across pairing, schedule, invitation, activation, and
password-reset email. A real SQLite regression saturates the five-type queue
and verifies that every type gets a first-round claim.

## Why there is no migration

Schema v6 already supplies versioned payloads, delayed `not_before` delivery,
unique idempotency keys, bounded attempts, leases, terminal suppression, dead
letters, and audit events. The schedule row already supplies the current truth
needed to invalidate stale work. Adding schedule-specific queue columns or a
second queue would duplicate those contracts without adding capability.

Schema v8 remains reserved for password recovery and recent-authentication
state in issue #82. This slice changes no migration checksum, manifest, or
production migration procedure.

## Alternatives considered

| Option | Advantages | Costs and decision |
| --- | --- | --- |
| Send inside the schedule request | Fastest visible email | Couples user latency and provider health to the write and can lose delivery after commit; rejected |
| Store recipient addresses in events | Simplifies rendering | Retains avoidable personal data and can send to a changed address; rejected |
| Cancel/update queued reminders | Keeps fewer pending rows | Adds mutable queue races and loses audit history; immutable events plus dispatch-time suppression chosen |
| Add a dedicated schedule-notification table | Domain-specific queries | Duplicates v6 leasing, retries, dedupe, and audit; rejected |
| Create one reminder event at scan time | No far-future outbox row | Requires a separate authoritative scanner and dedupe state; deferred unless scale requires it |
| Use Trigger.dev or Inngest | Rich scheduling and provider dashboards | Adds another processor and trust boundary; reconsider after private-beta volume outgrows the database relay |

## Remaining issue #50 work

- Rehearse these templates and suppression paths through a staging Resend
  domain; automated tests intentionally never call an external provider.
- Define product timing for additional reminders (for example one hour before)
  from usage data before adding more events.

SMS remains a possible future channel, but it is deliberately outside issue
#50 and is not a closure criterion for this email-notification slice.
