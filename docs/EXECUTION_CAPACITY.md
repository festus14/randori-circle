# Execution admission, quotas and pristine snapshots

Issue #468, epic #460; decision [ID-103](IMPLEMENTED_DECISIONS.md#id-103-bound-execution-admission-and-spend-with-a-durable-retry-queue-and-pristine-runtime-snapshots).
Implementation base: `e4eca0d` (migration 26). **Default off; no migration.**

## Admission and fairness

`EXECUTION_QUEUE_ENABLED=true` switches primary, solo and secondary executions
from the legacy account log lease to one serialized libSQL **write transaction**
over the existing `auth_rate_limits(key, attempts, expires_at)` table. The flag
is literal `true` only. Off preserves the existing provider payload, account
lease, ten-request/minute limiter, smoke budget and response shapes; snapshot
settings are ignored. The API never executes submissions in its own process.

One request costs one provider unit, or **two** with private stdin: verification
and private script run concurrently in distinct isolated environments. Admission
reserves the full cost and consumes all applicable quotas before either starts.
Account exclusivity spans circles, tabs, catalogue verification and stdin.
A quota failure reserves no provider units; retries do not consume run quotas.
Failed/aborted provider attempts do consume their reserved quota: no refunds that
could turn failures into unlimited spending.

TTL row namespaces (`eq1:`):

- `q`: one pending ticket per account, keyed by domain-separated HMACs of circle,
  account and the exact operation. Only priority and unit cost are plaintext.
  `attempts` holds the DB-clock enqueue millisecond; `expires_at` is UTC seconds.
  Code, stdin, room ids and raw account/circle ids are **not** stored. The operation
  HMAC fences a changed exercise, document version, code or stdin without retaining
  those bytes. It is non-reversible but confirmable by an operator holding the
  app secret and a candidate submission; it is not anonymous content. A
  different tab/operation cannot consume another pending ticket.
- `o`: short (at most three-second) selection offers. Offered units reserve
  global/circle/class capacity but spend no provider quota until claimed. The
  holder's retry promotes the offer to a generation-keyed live lease.
- `l`: expiring provider-unit lease, with an independent random generation token.
  Release is key-exact; a late cleanup cannot delete a newer generation.
- `t` / `s`: last-served circle turns and I,I,P weighted turn sequence, 15-minute
  expiry. Circles compete by least-recent service; requests within a class/circle
  are FIFO (deterministic HMAC tie-break at equal DB milliseconds).
- `r`: admitted provider-unit counters in UTC fixed minute/day windows. Account
  and circle dimensions use keyed hashes; global spend counters are aggregate.
- `policy`: a fingerprint rejects mixed active configurations/secret generations.
  Drain before changing limits or rotating `JWT_SECRET`.

Priority is **server-derived**, never a request-body hint. Primary exact two-human
rooms get interview priority only while the ID-99 state projection says live and
not ended, with `INTERVIEW_SESSION_ENABLED=true` and migration 26 available.
Lobby, ended, solo, practice, and secondary rooms are practice. Secondary rooms
have no ID-99 live-interview state; this change does not invent one. Existing
membership, canonical-code, lobby, timer and completion fences still apply.

When both classes wait, the configured interview share is protected from new
practice admissions, while practice reserves enough units for its largest pending
request (including the two-unit stdin case). Idle shares are borrowable. Already
running work is never killed to reclaim a share. In sustained eligible traffic,
the weighted selector offers two interview turns then one practice turn, with
round-robin across circles, not arrival-volume advantage for a busy circle.
All allocations also obey the global and per-circle ceilings.

This is a **retry queue, not a job queue**: an ordered fill set reserves every
eligible free unit, and the selected caller can claim any ticket in that set.
Other selections become durable **three-second offers** (part of the spend
reservation, not running VMs). Rotation/last-served turns advance on selection,
not just successful claims, and unclaimed offers expire/shed quickly. Thus one
absent head cannot freeze the I,I,P rotation or waste all free capacity. No worker
retains submissions or starts abandoned runs. Successful admission is not
guaranteed under overload: the 15-second maximum queue wait (configurable to 20)
and shorter offer lifetime bound waiting; overload sheds instead of spending.

## Failure and retry contract

There is no capacity sleep/poll loop. Admission uses four bounded attempts for
known SQLite/libSQL conflicts with 30/60/120 ms backoff plus small jitter. Native
SQLite COMMIT conflicts retry only when the transaction is still demonstrably
open and rollback is confirmed; remote/lost COMMIT replies never replay quotas.
Reads/writes use native libSQL batches: a normal admission uses five interactive
write-lock round trips (begin, snapshot batch, control read, write batch, commit),
not one RTT per counter or ticket. Scoped batches still validate context before
execution and again at commit. No Vercel function waits for provider capacity.

- Capacity/full/expired/queued/store/configuration: `503` with
  `{ok:false, code:"execution_busy", reason, retry_after}` and `Retry-After`.
- Quota exhaustion: `429`, same code, `reason:"quota"`, retry seconds to the
  applicable UTC window reset; no wrong-answer results or persisted run.
- Already-running/different pending operation: busy state, no duplicate provider
  dispatch. A rejected request says the code **was not run**, not that it failed.
- Unconfigured/unreachable provider retains the existing `execution_unavailable`
  contract. A stale configured snapshot does **not** trigger a second cold create.

The lazy Results UI says **“Execution is busy — retrying in Ns”** for a queued
ordinary run, plus an explicit Retry execution button. It retries at most the
15-second client window, only after an explicit busy response. It never retries
an HTTP failure with unknown outcome. Explicit `store` busy responses also get
bounded one-at-a-time retry. Quotas, shed and expired requests stay manual. Daily
limits display a fixed UTC reset time, with no 24-hour live countdown or disabled
retry button. Capability-enabled Run ignores a second click while a
request/preflight is in flight. Context/code change, hidden page, newer Run or a
removed results panel cancels delayed automatic retry. The retry captures fresh
code/authority; it never replays a retained POST.

**Private stdin is never automatically retried.** Its original application-owned
copies are discarded at dispatch as in ID-94. The busy state explicitly asks the
member to re-enter stdin, then retry. No new input/output persistence or telemetry
is introduced. The original provider privacy activation checks still apply.

Leases last **90 seconds**: 20-second create deadline + 60-second provider session
backstop + margin. The DB lease is checked immediately before each provider call;
less than 80 seconds of remaining cover refuses dispatch. Vercel delete/stop is
bounded and confirmed before early release. Creation failure or uncertain cleanup
keeps the lease to expiry. Piston successful terminal receipts allow early release;
HTTP abort/unknown process state does not. Piston operators must enforce server-side
process termination and workspace removal within 60 seconds even after disconnect.
Crash recovery is TTL-based, never a counter decrement guessed by a later worker.

## Configuration

All knobs are server-only decimal integer strings: no whitespace, exponent,
fraction, negatives or coercion. Empty/unset selects the documented default;
invalid enabled configuration fails closed before provider spend.

| Variable | Default | Accepted range / constraint |
| --- | ---: | --- |
| `EXECUTION_QUEUE_ENABLED` | `false` | literal `true` enables; otherwise legacy path |
| `EXECUTION_GLOBAL_CONCURRENCY` | 4 | 2–16 provider units, across member runs and guarded ops |
| `EXECUTION_CIRCLE_CONCURRENCY` | 2 | 1–8, no greater than global |
| `EXECUTION_INTERVIEW_SHARE` | 2 | 1–15, strictly less than global |
| `EXECUTION_ACCOUNT_PER_MINUTE` | 10 | 1–30 provider units / UTC minute |
| `EXECUTION_CIRCLE_PER_MINUTE` | 40 | 1–120 provider units / UTC minute |
| `EXECUTION_GLOBAL_PER_MINUTE` | 60 | 1–240 provider units / UTC minute |
| `EXECUTION_GLOBAL_PER_DAY` | 150 | 1–10000 provider units / UTC day |
| `EXECUTION_QUEUE_LIMIT` | 32 | 1–128 pending accounts globally |
| `EXECUTION_MAX_WAIT_SECONDS` | 15 | 2–20, not refreshed by the same request's retries |
| `EXECUTION_WARM_JAVASCRIPT_SNAPSHOT_ID` | unset | pristine `snap_…` id; server-only, never returned in health |
| `EXECUTION_WARM_PYTHON_SNAPSHOT_ID` | unset | pristine `snap_…` id; server-only, never returned in health |
| `EXECUTION_WARM_MEASURE_ENABLED` | `false` | literal `true` plus queue enabled and both Vercel snapshots |

Enabled admission requires the existing `JWT_SECRET` ≥32 UTF-8 bytes. With stdin
also enabled, global concurrency must be ≥4, circle concurrency ≥2, and interview
share ≤global−2, so both two-unit classes can make progress. Raising quotas is an
explicit spend decision; do not copy the maximum ranges into production. Default
150/day bounds a 31-day month to 4,650 creations including guarded smoke/preparation
calls, below the documented 5,000-creation Hobby allowance. This is a creations
bound, **not** a currency estimate, billing-plan guarantee or CPU/memory allowance
measurement. UTC fixed windows permit adjacent-window bursts; concurrency remains
an independent hard limit. Repeated aborted work never bypasses the daily cap.

## SDK-supported pre-warm

The installed and lockfile-pinned **`@vercel/sandbox` 3.8.0** declarations expose:

```js
const snapshot = await sandbox.snapshot({ expiration: 30 * 86400000, signal });
const isolated = await Sandbox.create({
  source: { type: 'snapshot', snapshotId: snapshot.snapshotId },
  resources: { vcpus: 1 }, timeout: 60000,
  networkPolicy: 'deny-all', persistent: false, signal,
});
```

Snapshot source and `image` are mutually exclusive in the SDK union. Restoration
preserves the deny-all network and fresh non-persistent execution/session cleanup.
**No snapshot is taken after submitted code.** No VM instance is shared between
members or between verified/private executions. Piston has no snapshot API and
continues cold; no unsupported API or provider-neutral performance claim is made.

`scripts/execution-prewarm.mjs` is an explicit operator action requiring
`javascript|python --confirm-spend`, queue enabled and Vercel provider. It reserves
one guarded ops unit, creates the same managed runtime with no files/env/ports/
mounts, runs only its fixed `--version` command, takes a 30-day pristine snapshot,
deletes/stops the builder VM and prints the configuration assignment. It is never
run by a request, unit test with real SDK, automatic replenisher, or this branch's
validation. It needs the operator's authorized provider/DB credentials. Do not
supply snapshots from arbitrary third-party builders or member runs: only this
pristine builder's snapshot is suitable. Storage/session/billing characteristics
must be checked by the operator before activation. Before enabling the queue,
verify exactly one non-archived primary circle exists for unscoped fallback runs.
Enabled readiness and admin queue configuration report `primary_circle` if that
precondition is missing; no request creates a circle or changes schema. Renew
before expiry, and remove
obsolete snapshots through the provider's normal operator controls.

Snapshots restore saved runtime/filesystem state, **not a promise of retained CPU
caches or lower latency**. Managed-image start may already be optimized. Performance
is measured rather than assumed.

## Observable evidence and cold-start p95 measurement

Global-admin `GET /api/admin/diagnostics` (existing `ADMIN_DIAGNOSTICS_ENABLED=true`
security gate, `Cache-Control:no-store`) extends `cards.execution` with:

- `queue`: current depth, active provider units and offered-unit reservations;
  recorded admitted/shed/quota/store/configuration/finished counts over 15 minutes;
  wait and provider boundary wall-latency
  `{samples,p50,p95}` in milliseconds; configured spend ceilings and consumed
  provider units in the current UTC minute/day; sample truncation.
- `warm`: fixed JavaScript/Python supported/configured booleans only.
- `coldStart`: paired cold/snapshot creation measurements for the current immutable
  snapshot cohort over the log's 30-day retention. No snapshot id/cohort hash escapes.

The existing lazy admin card renders these fields with text-only DOM. Public
liveness/readiness bodies and schema contracts are unchanged. No account/circle
breakdown, code, stdin, output, provider URL or error text leaves this endpoint.
`runner/execution_queue_metric` rows have **NULL user_id, route, ua and ip** and
fixed event names plus bounded numeric metadata. Browser telemetry cannot forge
`runner` evidence. Queue waits include admitted and expired attempts; provider
latency includes cleanup and dual-run wall time, not just command CPU time. No
samples means null percentiles, never zero latency. Counts describe **recorded**
metrics, not guaranteed complete decisions: inserts are bounded best effort,
batched outside the admission lock, and may be lost when the store itself is
unwritable. Store/configuration refusals have explicit counters and degrade the
admin card when recorded; a failed read is unavailable, not a healthy empty queue.
Percentile reads cap at 4,096 samples and report truncation.

The **existing execution-smoke workflow** still invokes the cron-secret-protected
API; it cannot send custom programs or choose its sample count. When queue and
warm measurement are both enabled, the existing atomically throttled claim runs
one cold and one pristine-snapshot trivial program **per language**, checks the
same output, and records only the paired `Sandbox.create` durations. Thus each
real claim costs four creations instead of two. The existing 30-minute gap and
schedule/deploy slots remain, at most 70 claims/month ⇒ **280** creations/month,
also counted against the global quota. Individual language measurement is bounded
at 90 seconds, inside the workflow's existing 100-second HTTP deadline. No PR/load
workflow is added and nothing contacts a provider in local gates.

`github-execution-smoke.mjs` reports allowlisted p50/p95 aggregates. At least **20
paired successful samples per language in one current snapshot cohort** are
required before claiming improvement. It fails with `warm_latency_regression`
when a sufficiently sampled warm p95 is not lower than cold p95. Before then it
reports `sufficient:false`, `improved:null` (not a proven benefit). Snapshot-id or
SDK/runtime cohort change resets evidence; an old snapshot cannot prove a new
one is faster. Daily/post-deploy claims accumulate samples without an unbounded
benchmark. The standalone `scripts/execution-smoke.mjs` also reports a cold/warm
startup pair using its existing reference/broken runs; a single pair is explicitly
insufficient for p95 acceptance. It is not part of CI and was **not run here**.

### Admission contention in smoke

Queue-enabled admission contention is a distinct `busy` language result, not a
provider error. The assessor emits `status:"deferred"` and a notice, without
alerting or asserting a provider pass. A throttled cached busy result remains
explicitly deferred. Admin smoke status is `busy`, never `passed`, and cannot lift
an unknown execution card to healthy. Invalid admission configuration remains a
misconfiguration failure. The existing smoke claim/trigger budget is unchanged.

**Outstanding acceptance evidence:** this provider-free branch cannot demonstrate
live cold-start p95 improvement. Leave the flag off until the owner performs the
bounded rollout and records sufficiently sampled workflow evidence. See the
[runbook](runbooks/execution-capacity.md) for tuning, renewal and rollback.

## Storage, deletion, export and compatibility

No schema object, migration contract/checksum/manifest, ledger entry or readiness
threshold changes. Unit fixtures assert ledger v26. The existing account-deletion
and data-export inventories already cover both reused tables: keyed TTL operational
state is not user content and cannot be directly joined to a member; aggregate
metrics carry no member identity. Export still excludes these records, with the
exclusion description updated for execution admission. Quota/ticket/turn rows
expire logically at their deadlines; bounded prefix-only opportunistic cleanup
removes old rows, and the existing auth TTL sweeper can also remove them. Aggregate
logs follow the existing 30-day app-log retention. An account deletion does not
release an uncertain running VM's lease early; safe expiry preserves the spend
ceiling and no personal execution bytes are added to backups.
