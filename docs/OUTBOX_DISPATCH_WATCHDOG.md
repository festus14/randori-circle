# Outbox-dispatch watchdog

Decision:
[ID-43](IMPLEMENTED_DECISIONS.md#id-43-treat-only-scheduled-outbox-runs-as-freshness-evidence)

Status: code complete and rebased onto the current rolling release; keep the
pull request draft until final validation completes. No migration or production
credential is required.

## Purpose and authority

`.github/workflows/outbox-dispatch.yml` is the only production notification
worker. It is scheduled every five minutes, has a two-minute job timeout, and
can also be run manually for recovery. A missing or unhealthy schedule can
delay pairing, scheduling, invitation, activation, and password-reset mail even
when the durable outbox and provider configuration are healthy.

`.github/workflows/outbox-dispatch-watchdog.yml` checks that scheduler once per
hour at minute 37 and can be run manually for diagnosis. It queries only the
GitHub Actions history for `outbox-dispatch.yml`. It never calls the application,
dispatches another workflow, reads a production environment, or receives an
application, database, cron, or provider credential.

Only an initial (`run_attempt == 1`) `schedule` run on the repository default
branch is authoritative. A `workflow_dispatch` run, feature-branch run, or
human rerun can help an operator recover but cannot make freshness healthy.
Freshness uses `created_at`, never a mutable `updated_at`.

## Time and outcome contract

The source cadence is five minutes. The watchdog computes the current
five-minute UTC slot and a freshness floor by subtracting the documented
15-minute scheduling grace and rounding down to a five-minute slot. This makes
the boundary deterministic while allowing ordinary GitHub schedule delay.

The newest authoritative run determines the result:

| Outcome | Alert | Meaning |
| --- | --- | --- |
| `healthy` | no | The newest scheduled run succeeded in the current slot. |
| `schedule_grace` | no | A prior scheduled run remains inside the accepted grace, or the newest run is still queued/running within its limit. |
| `run_missing` | yes | No authoritative scheduled attempt was found. |
| `run_stale` | yes | The newest success or active attempt predates the freshness floor. |
| `run_failed` | yes | The newest attempt failed, timed out, or ended in another unsuccessful conclusion. |
| `run_cancelled` | yes | The newest attempt was cancelled. |
| `run_skipped` | yes | The newest attempt was skipped. |
| `run_stuck` | yes | An in-progress run reached the dispatcher's exact two-minute job deadline. |
| `manual_rerun` | yes | The newest scheduled occurrence was manually rerun; wait for a new initial scheduled attempt. |
| `malformed_response` | yes | GitHub returned invalid JSON, an invalid page, or inconsistent run metadata. |
| `api_failure` | yes | Configuration, authentication, HTTP, network, or timeout prevented a decision. |

An older success cannot hide a newer failure. The watchdog emits `observing`
while an authoritative queued or in-progress run remains inside its boundary;
this is non-alerting but is not reported as a successful delivery.

## Bounded discovery and privacy

The GitHub query pins the workflow filename, `event=schedule`, and the exact
default branch. Local validation repeats those filters. Discovery constructs
its own page URLs, reads at most two pages of 100 runs, caps each response at
2 MiB, and shares one absolute ten-second API budget across both pages. It does
not follow response-supplied URLs.

Output is one versioned JSON object containing only fixed outcome values,
bounded page/run counts, run ID and attempt, fixed status/conclusion values,
and UTC/elapsed timing metadata. It excludes workflow/provider response bodies,
web URLs, commit content, actors, recipients, notification payloads, and every
credential. One monotonic deadline covers every page and body read, so a wall
clock adjustment cannot extend the budget. Exceptions are converted to a fixed
category.

The workflow has only `actions: read` and `contents: read`; checkout does not
persist credentials and every action is commit-pinned. The deployability gate
rejects removal or weakening of the watchdog, its exact fail-closed command,
its bounds, the dispatcher's two-minute deadline, or the
secret-free/non-mutating boundary. Reviewed SHA-256 digests bind both the
workflow and assessor, so adding an unreviewed step or changing executable
behavior requires an explicit contract update.

## Recovery and rollout

For any alert:

1. Inspect the named `outbox-dispatch` Actions run and repository scheduler
   configuration.
2. Fix the dispatcher or GitHub configuration; do not add production secrets
   to the watchdog.
3. Use the dispatcher's existing manual action to drain delayed durable work.
4. Confirm the next genuine scheduled attempt succeeds. A manual run or rerun
   intentionally does not restore watchdog health.

Deploying or reverting this watchdog changes no schema and no application data.
Rollback removes or disables only the watchdog workflow; it must not disable,
dispatch, or modify the production worker or its durable outbox.

## Alternatives considered

- A second secret-bearing scheduler could invoke production independently, but
  it duplicates privileged configuration and can create correlated delivery or
  double-invocation risk. Reconsider only after the primary scheduler is
  operating and measured.
- Calling the application health endpoint would test deployment reachability,
  not whether GitHub schedules the worker, and would require another external
  trust boundary.
- Treating manual dispatch or rerun as fresh would make recovery convenient but
  could conceal an indefinitely broken schedule.
- An unbounded Actions-history scan adds latency and attack surface without
  improving the decision because GitHub returns newest runs first.
- Terminal-event retention is useful for database growth but needs a separate
  retention/audit policy and does not detect stopped delivery.
