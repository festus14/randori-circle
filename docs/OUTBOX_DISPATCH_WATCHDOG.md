# Outbox-dispatch watchdog

Decision:
[ID-43](IMPLEMENTED_DECISIONS.md#id-43-treat-only-scheduled-outbox-runs-as-freshness-evidence)

Updated by
[ID-67](IMPLEMENTED_DECISIONS.md#id-67-run-an-external-outbox-scheduler-beside-github-and-alert-on-delivery-health):
the alert now depends on delivery health. GitHub run cadence is a
non-failing warning.

## Purpose and authority

Two schedulers call `POST /api/cron/outbox`: the checked-in
`.github/workflows/outbox-dispatch.yml` (every five minutes, best effort) and
an external cron-job.org job ([setup](OUTBOX_EXTERNAL_SCHEDULER.md)). GitHub
often delays the first one by hours. The question that matters is whether due
mail is being delivered, not which scheduler delivered it.

Since [ID-64](IMPLEMENTED_DECISIONS.md#id-64-deliver-auth-and-invitation-email-immediately-after-commit),
password-reset, activation, invitation, and schedule mail is normally sent
right after its request commits, so a stalled drain mainly delays pairing mail
and retries.

`.github/workflows/outbox-dispatch-watchdog.yml` runs once per hour at minute
37 and can be run manually for diagnosis. It runs in the protected
`production` environment and receives only `vars.APP_URL` and
`secrets.CRON_SECRET`. With those it sends one bounded `GET` to
`/api/cron/outbox-health` (ten-second timeout, 2 MiB cap). It never drains the
outbox, dispatches a workflow, or writes anything.

## Delivery outcome (decides the alert)

The threshold is `WATCHDOG_DELIVERY_MAX_AGE_MS` (15 minutes).

| Category | Alert | Meaning |
| --- | --- | --- |
| `null` (`healthy`/`warning`) | no | Nothing due or leased is older than 15 minutes. |
| `delivery_stale` | yes | `oldestDueAgeMs` is over 15 minutes: due `pending`/`retry` mail is not being drained. |
| `lease_stale` | yes | `oldestStaleLeaseAgeMs` is over 15 minutes: an expired `processing` lease has not been reclaimed. |
| `health_unavailable` | yes | Network failure, timeout, or any non-2xx except 401/403 (including 503: database unavailable, or 404: not deployed). |
| `health_unauthorized` | yes | 401/403: `CRON_SECRET` in GitHub does not match Vercel. |
| `malformed_health` | yes | The response was invalid JSON or an inconsistent aggregate document. |
| `health_config_missing` | yes | `APP_URL` is not an HTTPS origin, or `CRON_SECRET` is empty. |
| `watchdog_failure` | yes | Invalid watchdog configuration or usage. |

These warnings never fail the job:

- `dead_letters_recent`: at least one dead letter in the last 24 h.
- `delivery_backlog`: due or expired-lease events exist but are still inside
  the threshold.
- `github_<category>`: the GitHub schedule assessment described below
  alerted, for example `github_run_stale`.

The output is one `randori.outbox-dispatch-watchdog.v2` JSON document with
`ok`, `status`, `alert`, `category`, `checkedAt`, `deliveryMaxAgeMs`,
`delivery` (the aggregate health fields), `warnings`, and `githubSchedule`
(the secondary assessment). It never contains the app URL, secrets, payloads,
or recipients.

## GitHub schedule signal (secondary, non-failing)

Only an initial (`run_attempt == 1`) `schedule` run on the repository default
branch is authoritative. A `workflow_dispatch` run, feature-branch run, or
human rerun can help an operator recover but cannot make freshness healthy.
Freshness uses `created_at`, never a mutable `updated_at`.

## Time and outcome contract

The source cadence is five minutes. The watchdog computes the current
five-minute UTC slot and a freshness floor by subtracting the documented
15-minute scheduling grace and rounding down to a five-minute slot. This makes
the boundary deterministic while allowing ordinary GitHub schedule delay.

The newest authoritative run determines the `githubSchedule` result. Any alert
category below becomes a `github_<category>` warning, not a failure:

| Outcome | Warning | Meaning |
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
its bounds, the dispatcher's two-minute deadline, any production reference
other than `vars.APP_URL`/`secrets.CRON_SECRET`, or any write or mutating
step. Reviewed SHA-256 digests bind both the
workflow and assessor, so adding an unreviewed step or changing executable
behavior requires an explicit contract update.

## Recovery and rollout

For a delivery alert:

1. `delivery_stale`/`lease_stale`: check the cron-job.org job history and the
   latest `outbox-dispatch` run. Then run `outbox-dispatch` manually, or use
   "Test run" in cron-job.org, to drain. If drains succeed but the age keeps
   growing, look at provider errors and `outbox_invocation` logs.
2. `health_unauthorized`/`health_config_missing`: make the `production`
   environment's `APP_URL`/`CRON_SECRET` match Vercel.
3. `health_unavailable`: check `/api/health/ready` and the database.
4. Confirm the next hourly watchdog run is green. A `github_*` warning alone
   needs no action while delivery is fresh.

Deploying or reverting this watchdog changes no schema and no application data.
Rollback removes or disables only the watchdog workflow; it must not disable,
dispatch, or modify the production worker or its durable outbox.

## Alternatives considered

- Judging only GitHub run cadence (ID-43) alerted permanently, because GitHub
  delays `*/5` schedules by hours, and it said nothing about mail sent by an
  external scheduler.
- Treating manual dispatch or rerun as fresh would make recovery convenient but
  could hide a schedule that is broken indefinitely. The GitHub signal still
  ignores them.
- An unbounded Actions-history scan adds latency and attack surface without
  improving the decision, because GitHub returns the newest runs first.
