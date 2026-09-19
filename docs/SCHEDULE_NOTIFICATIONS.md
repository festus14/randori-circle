# Schedule email notifications

Status: first issue #50 slice implemented in
[PR #96](https://github.com/festus14/randori-circle/pull/96) on the
verified-email-activation stack

This slice sends durable email notifications for schedule proposals, accepted
times, changed or cleared agreements, and accepted-session reminders. SMS,
owner invitation-link delivery, and a live staging-provider rehearsal remain
outside this slice, so this work references but does not close issue #50.

## Event and transaction contract

Schedule mutations keep their existing optimistic `base_version` contract. A
successful schedule write and every resulting `schedule.email.requested` v1
event are committed in one libSQL write transaction. If any event insert fails,
the schedule write rolls back. A stale compare-and-swap commits neither the
schedule nor notification work.

The event uses template version 1 and an idempotency key with this shape:

```text
schedule-email/v1/{week}/{pair}/{kind}/{schedule-version}/{recipient-user}
```

The payload contains only the event kind, stable database identifiers, current
and previous instants, schedule version, and template version. It deliberately
does not contain an email address, bearer token, invitation link, message body,
or display name. The worker resolves those values at dispatch time. The shared
outbox limits each event to five attempts and a ten-second provider timeout.
The serverless drain claims at most three schedule emails per invocation, which
bounds this newly added slice to at most 30 seconds of provider wait.

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
- no newer event supersedes the same proposal, agreement notice, or reminder
  (including an A-to-B-to-A reschedule);
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

This does not yet impose one deadline across every typed worker in
`/api/cron/outbox`: the older pairing drain, schedule drain, and activation
drain still run sequentially, and the older drains retain their larger default
batches. A slow earlier drain can therefore starve later types or approach a
serverless invocation limit. [Issue #94](https://github.com/festus14/randori-circle/issues/94)
tracks one shared deadline/claim budget (or separate authenticated schedules)
before the queue is considered high-volume production ready.

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

- Deliver owner-created invitation links without manual copying, using a
  short-lived safe-link contract and revocation checks.
- Rehearse these templates and suppression paths through a staging Resend
  domain; automated tests intentionally never call an external provider.
- Define product timing for additional reminders (for example one hour before)
  from usage data before adding more events.
- Design SMS consent, verified phone ownership, quiet hours, regional rules,
  provider choice, and STOP handling. No SMS credential or send path is added
  by this slice.
