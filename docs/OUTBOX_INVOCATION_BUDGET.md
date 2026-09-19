# Outbox invocation budget

Status: [PR #104](https://github.com/festus14/randori-circle/pull/104)
bounded candidate, stacked on invitation-email PR #100

## Runtime contract

`GET|POST /api/cron/outbox` has one request-scoped deadline rather than one
independent budget for each notification type:

| Limit | Value | Purpose |
| --- | ---: | --- |
| Production function target | at least 60 seconds | Hosting/scheduler requirement |
| Application work budget | 45 seconds | Admission, provider-wait, finalization, and metrics deadline |
| Finalization reserve | 5 seconds | Finish claimed leases, metrics, log, and response |
| Global claim cap | 8 events | Bound database/provider work per invocation |
| Event provider timeout | at most 10 seconds | Preserve each event's stricter v6 policy |
| Sweep limit | 1 exhausted lease per type | Bound maintenance after useful delivery work |

One SQL claim round selects at most one due event for every configured type.
Only after every type receives that opportunity may another round begin. The
round's handlers run concurrently, so a slow saturated pairing queue does not
prevent a sparse schedule, invitation, or activation event from progressing.
No new round starts after the admission window closes. Each already-started
finalization receives a fair slice of the remaining reserve; one failed or slow
transition cannot prevent a later sent event from attempting its own finalize.
Its heartbeat remains active until that event finishes its transition or uses
its allotted slice.

The runner also stops awaiting a claim at the admission cutoff. Because libSQL
cannot cancel that statement, a claim that commits afterward is observed in a
non-provider cleanup continuation and resolved to the normal bounded
`INVOCATION_DEADLINE` retry/dead-letter outcome. If the process is reclaimed
first, the database lease expires and the next invocation recovers it.

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
An event whose last allowed attempt is consumed before dispatch moves directly
to dead letter with `INVOCATION_DEADLINE`; it cannot become an unclaimable retry.

The legacy pairing compatibility bridge reconciles at most eight new rows and
is timeboxed before the admission cutoff. The post-run backlog read and
persistent invocation log are timeboxed to the absolute deadline; logging is
skipped when an earlier stage already reports a deadline. An incomplete metrics read is represented explicitly by
`metrics_complete: false` and `null` backlog/dead-letter values rather than a
false zero. `logging_complete` makes best-effort telemetry equally explicit.

libSQL does not expose per-statement cancellation. A statement admitted before
the cutoff can therefore settle after the application deadline; the worker
does not intentionally start or await further work after its allotted window.
Claims remain protected by the 30-second renewable lease and stable provider
idempotency key. The 60-second hosting limit is the outer safety boundary for
this non-cancellable storage tail, so the 45-second value is not documented as
a hard process-termination guarantee.

## MVP scheduler

`.github/workflows/outbox-dispatch.yml` invokes the production endpoint every
five minutes and also supports an operator-triggered recovery run. It reads the
canonical HTTPS origin from the protected production environment variable
`APP_URL` and the authentication credential from the environment secret
`CRON_SECRET`; missing or unsafe configuration fails the job visibly. The HTTP
request has a 55-second timeout and automatic retry is disabled because event
retries belong to the durable outbox. The job-level default-branch guard also
applies to manual runs, so a feature-branch workflow cannot read the production
secret or invoke the production endpoint. Keep the production environment's
deployment-branch restriction pinned to the repository default branch as a
second control.

The MVP delivery target is within five minutes under normal GitHub Actions
scheduling. GitHub scheduled workflows can be delayed, so this is an operating
target rather than a strict SLA. Move the same endpoint contract to a managed
queue/cron with delivery-lag alerting when a strict latency SLO or higher volume
is required. Vercel Hobby cron is not used for this five-minute cadence.

## Metrics and privacy

The cron response and `outbox_invocation` log contain only:

- global budget, claim limit, claimed count, and deadline-reached flag;
- per-type claimed, delivered, suppressed, retried, newly dead-lettered, and
  lease-lost counts;
- per-type current actionable backlog and dead-letter count.

`metrics_complete` distinguishes an exact post-run backlog from a deadline-
bounded response where those two gauges are `null`.

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
| Vercel Hobby cron | Co-located scheduling | Does not support the required five-minute MVP cadence; rejected |
| Managed queue/cron | Stronger latency and retry guarantees | Added operating cost and infrastructure; preferred upgrade when strict delivery SLOs are needed |
| Parallel fair rounds | Later types start even when an earlier provider is slow | Adds controlled concurrency; chosen with a global cap and shared deadline |

## Remaining issue #94 scope

This branch contains pairing, schedule, invitation, and activation adapters.
Password recovery is being built independently and is not in the base commit.
Issue #94 remains open until the stacks are linearized, recovery is registered
in the same fair dispatcher, and a mixed five-type saturation test passes.
