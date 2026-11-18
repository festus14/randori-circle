# Execution capacity tuning and rollback

Use for busy/quota states or cold-start regression (#468 / ID-103).
[Design, strict ranges and metric semantics](../EXECUTION_CAPACITY.md).
No migration is required; the code runs on v26. Do not reuse v27 from parallel
work. This runbook describes operator actions, not actions performed by CI.

## Activate safely

1. Deploy with `EXECUTION_QUEUE_ENABLED=false`. Run the provider-free focused
   admission/provider/UI tests and existing deployability gates. Confirm ordinary
   Run and schema readiness retain their pre-flag behaviour.
2. Set `EXECUTION_PROVIDER` unset and redeploy to stop new provider admissions.
   Drain old requests for at least 90 seconds before switching the admission flag,
   quotas, JWT secret generation or restoring old code. Pause manual provider
   smoke/preparation during the drain. Never mix flag-OFF and flag-ON executors
   against the same provider: the old code cannot participate in the new ceiling.
3. Before activation, verify exactly one non-archived primary circle exists for
   unscoped execution. The admin execution card reports missing-primary/config
   errors and new execution requests fail closed; whole-app `/api/health/ready`
   and admin initialization retain the existing DB/schema readiness contract.
   Complete the normal primary-circle bootstrap first; no execution request
   creates that circle.
   Choose a provider/project budget. Start with global 4, circle 2, interview share
   2, account 10/min, circle 40/min, global 60/min and **150 provider units/day**.
   Set `EXECUTION_QUEUE_ENABLED=true` and the same config/secret on every execution
   instance. Redeploy, then re-enable the provider. Invalid config/store errors
   must produce busy responses and **zero provider creations**.
4. Use the existing global-admin Diagnostics view/API to confirm active units
   never exceed the ceiling, tickets age out (15 s), and shed/quota states are clear.
   Exercise bursty interviews plus practice with non-sensitive fixtures; compare
   actual provider creation/CPU/memory billing counters with these aggregate counts.
   Monitor 429/503 rates and verify the canonical run attestation/feed is unchanged.
5. Keep `EXECUTION_STDIN_ENABLED` off until its separate ID-94 provider command-log,
   disconnect-kill and cleanup privacy checks are complete. When enabled it costs
   two units/request; do not lower global below 4, circle below 2 or reserve more
   than global−2 for interviews. Private busy requests require re-entered stdin.

## Prepare and measure snapshots (operator-owned, paid)

Only with explicit owner approval, authenticated provider/DB credentials, and the
same enabled admission config as the deployment:

```bash
node --env-file=.env.local scripts/execution-prewarm.mjs javascript --confirm-spend
node --env-file=.env.local scripts/execution-prewarm.mjs python --confirm-spend
```

Each invocation creates **one** guarded VM, executes only a fixed interpreter
version command, snapshots a pristine runtime with 30-day expiry and cleans up
its VM. Put the printed assignments in Vercel server-only environment settings;
never use a submitted-code VM snapshot. There is no automatic replenisher.

Redeploy with the two snapshot ids and `EXECUTION_WARM_MEASURE_ENABLED=true`.
The existing protected execution-smoke workflow reports paired cold/warm startup
p50/p95 over a current 30-day cohort. Wait for ≥20 successful pairs/language
before accepting “improved”. Review its JSON and the admin card; insufficient
samples are not proof. A sufficiently sampled non-improvement fails the workflow
with `warm_latency_regression`. Record the cohort's runtime/SDK version, sample
count, cold and snapshot p95, interval and provider spend evidence in the rollout
review. This branch cannot produce that evidence without live provider access.

Renew snapshots before their 30-day expiry and delete obsolete provider snapshots
through ordinary operator controls. A new id resets measurement evidence. Stale
ids fail unavailable with **no automatic cold fallback**, preventing doubled
spend. Clear a bad snapshot id and redeploy to choose cold runs explicitly.
The standalone execution-smoke script reports a pair but one invocation is not a
statistically sufficient p95 benchmark; never run it in provider-free tests.

## Diagnose and tune

- **Queue depth/shed increasing:** first reduce abusive account/circle quotas or
  stop optional smoke/preparation. Raising global concurrency increases spend
  rate. Only raise it after confirming provider plan and CPU/memory headroom.
- **Interviews waiting while practice is active:** check actual live ID-99 phase
  (not a client priority label), then interview share. Share protects new
  admissions, not already-running VMs. Never starve practice; retain enough units
  for its two-unit stdin ticket when applicable.
- **429 quota:** `retry_after` is the UTC minute/day reset. Daily refusal returns
  `quota_window:"day"` and `reset_at`; the UI shows that fixed UTC clock rather
  than a 24-hour live countdown. Do not auto-retry each
  second. A high daily cap is not an allowance guarantee; lower it for a shared
  project or a tighter remaining monthly budget.
- **Provider create failures/outage:** a failed or ambiguous create holds its
  spend lease for the full 90-second backstop; this can deliberately occupy all
  four default slots even while the provider has no running VMs. Unset provider
  and drain, rather than deleting leases or raising spend ceilings to compensate.
- **Capacity stays occupied after a function crash:** wait for the 90-second
  lease backstop and check provider termination. Never delete live lease rows or
  manually decrement counters to recover capacity; that can spend twice.
- **`configuration_changed`:** mixed limits or app-secret generations were seen
  while tickets/leases existed. Stop new provider runs, drain and redeploy one
  coherent config. Do not bypass the fingerprint fence.
- **Execution misconfiguration is not a deployment-readiness failure.** Keep
  `/api/health/ready` for DB/schema/membership concerns. Use the admin execution
  card and execute response to diagnose bad execution knobs/snapshots/primary
  fallback settings; never gate admin initialization on execution configuration.
- **Local file contention:** `api/_db.js` now enables WAL before any local client
  method runs. This is local-file startup only, not a remote Turso PRAGMA or a
  migration. Verify the local client with the focused WAL tests; do not change a
  remote database journal mode to diagnose execution.
- **Store/lock failure:** four attempts retry known conflicts with short jitter;
  ordered fill sets reserve all eligible slots through three-second offers.
  Investigate persistent DB availability/latency. Store/configuration refusal
  counts are recorded outside the lock, best effort, and can be lost when writes
  themselves fail. No admission retry
  is performed on ambiguous commit. Percentile samples may be truncated at high
  volume; the metric flag makes that explicit.

## Roll back

For an incident, **unset `EXECUTION_PROVIDER` and redeploy first**. That is the
spend-stop switch, not just a UI flag. Drain in-flight sessions for at least
90 seconds. Then set `EXECUTION_QUEUE_ENABLED=false`, unset snapshot ids and warm
measurement, redeploy and restore the original provider configuration only if
returning to legacy unqueued behaviour is acceptable. Turning off admission alone
removes the new spend ceilings; do not describe it as an emergency spend stop.
No schema rollback, migration, table deletion or user-data rewrite is necessary.
TTL rows expire and normal bounded cleanup can remove them. Logs retain only
aggregate counts/timings and follow existing retention. Keep ID-94 privacy gates
and the original provider kill/isolation contract intact through rollback.
