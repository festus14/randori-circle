# Outbox invocation budget

Status: [PR #104](https://github.com/festus14/randori-circle/pull/104)
bounded candidate, stacked on invitation-email PR #100

## Runtime contract

`GET|POST /api/cron/outbox` has one request-scoped deadline rather than one
independent budget for each notification type:

| Limit | Value | Purpose |
| --- | ---: | --- |
| Production function target | at least 60 seconds | Hosting/scheduler requirement |
| Application invocation budget | 45 seconds | Hard admission and provider-wait deadline |
| Finalization reserve | 5 seconds | Finish claimed leases, metrics, log, and response |
| Global claim cap | 8 events | Bound database/provider work per invocation |
| Event provider timeout | at most 10 seconds | Preserve each event's stricter v6 policy |
| Sweep limit | 1 exhausted lease per type | Bound maintenance after useful delivery work |

One SQL claim round selects at most one due event for every configured type.
Only after every type receives that opportunity may another round begin. The
round's handlers run concurrently, so a slow saturated pairing queue does not
prevent a sparse schedule, invitation, or activation event from progressing.
No new round starts after the admission window closes.

Weekly publication only commits pairing events and reports their durable
backlog; it no longer calls a provider or starts a separate unbounded typed
drain. The authenticated `/api/cron/outbox` endpoint is the sole scheduled
fan-out path. Manual publication follows the same queue-only response so its
request latency is independent of mail-provider health.

Every provider call receives the existing abort signal. Its timeout is the
lesser of the event's stored timeout and the shared remaining budget. If the
admission window disappears after claims commit but before a provider starts,
those events are finalized to bounded retry with `INVOCATION_DEADLINE`; they are
not left waiting for lease expiry. Normal retry/dead-letter policy, heartbeat,
lease-token ownership checks, and provider idempotency keys are unchanged.

## Metrics and privacy

The cron response and `outbox_invocation` log contain only:

- global budget, claim limit, claimed count, and deadline-reached flag;
- per-type claimed, delivered, suppressed, retried, newly dead-lettered, and
  lease-lost counts;
- per-type current actionable backlog and dead-letter count.

No payload JSON, recipient address, bearer token, rendered message, provider
body, or idempotency key is included. The development-only capture remains in
the existing local response shape and never enters persistent logs.

## Failure and operator behavior

- Empty queues return immediately without claims.
- Retryable provider failures retain bounded exponential backoff.
- Unsupported/invalid events still dead-letter through their typed handlers.
- A worker that loses its lease cannot commit a terminal outcome.
- Events left due after the claim cap or deadline remain eligible for the next
  authenticated invocation.
- Dead-letter replay remains an explicit audited administrator action.

No migration is required; this is scheduling around the schema-v6 outbox.

## Alternatives considered

| Option | Advantage | Cost and decision |
| --- | --- | --- |
| Keep sequential typed drains | Minimal change | Independent 100-event/10-second limits compose into an unbounded request and starve later types; rejected |
| Eagerly send after weekly publication | Immediate local capture | Bypasses the global budget and couples publication to provider latency; removed |
| Oldest event globally | Simple ordering | A busy type can monopolize every invocation; rejected |
| Persist a round-robin cursor | Fair across very small caps | Requires schema/config coordination; unnecessary because the global cap is at least the active type count |
| Separate cron route per type | Strong isolation | More schedules, secrets, monitoring, and concurrent functions; deferred if volume warrants it |
| Parallel fair rounds | Later types start even when an earlier provider is slow | Adds controlled concurrency; chosen with a global cap and shared deadline |

## Remaining issue #94 scope

This branch contains pairing, schedule, invitation, and activation adapters.
Password recovery is being built independently and is not in the base commit.
Issue #94 remains open until the stacks are linearized, recovery is registered
in the same fair dispatcher, and a mixed five-type saturation test passes.
