# Scheduler stopped

Outbox mail is ageing because neither scheduler is draining it. The
descriptive layer is [SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md) §5.1–§5.2
and §5.5, and the detailed scheduler docs are
[OUTBOX_EXTERNAL_SCHEDULER.md](../OUTBOX_EXTERNAL_SCHEDULER.md) and
[OUTBOX_DISPATCH_WATCHDOG.md](../OUTBOX_DISPATCH_WATCHDOG.md).

## Symptoms

- `/api/cron/outbox-health` shows `oldestDueAgeMs` over 15 minutes.
- The hourly outbox watchdog alerts `delivery_stale` (due
  `pending`/`retry` mail not draining) or `lease_stale` (an expired
  `processing` lease not reclaimed).

Two schedulers call `POST /api/cron/outbox`, and either one alone is
enough:

| Scheduler | Cadence | Credential |
| --- | --- | --- |
| cron-job.org (primary) | Every 5 minutes | `OUTBOX_DISPATCH_SECRET`, stored in cron-job.org only, never in GitHub |
| GitHub `outbox-dispatch` workflow (backup) | Every 5 minutes, best effort | `CRON_SECRET` from the protected `production` environment |

Running both at once is safe: each claim is a lease-based, idempotent
database update, so two dispatchers never send the same delivery key
twice. GitHub often delays its schedule by hours; that alone is not
an incident. The signal that matters is mail age, not which scheduler
ran last.

## Confirm (read-only)

```bash
curl -s https://randoricircle.com/api/cron/outbox-health \
  -H "Authorization: Bearer $OUTBOX_DISPATCH_SECRET"
# dueCount, oldestDueAgeMs, processingStaleCount, oldestStaleLeaseAgeMs.

gh run list --workflow outbox-dispatch.yml --limit 5
gh run list --workflow outbox-dispatch-watchdog.yml --limit 3
# GitHub-side evidence. A delayed GitHub run shows only as a
# github_run_stale warning while delivery stays fresh.
```

Then check the cron-job.org job history in its dashboard. A
`health_unavailable` watchdog alert means the health endpoint itself
failed (network, timeout, non-2xx) — check readiness first
([readiness-503 triage](readiness-503.md)). A `health_unauthorized`
alert means the `production` environment's `CRON_SECRET` does not
match Vercel's.

## Fix

- **cron-job.org job failing or disabled:** check the job URL
  (`https://randoricircle.com/api/cron/outbox`), method `POST`, the
  `Authorization: Bearer <OUTBOX_DISPATCH_SECRET>` header, the
  `*/5 * * * *` schedule, and that the job is enabled with failure
  notifications on. Use "Test run" and expect HTTP 200. A 401 means
  the secret is wrong, too short (under 32 characters), or not yet
  deployed; a 503 means the outbox or database is unavailable.
- **GitHub workflow failing:** check the `production` environment
  holds `APP_URL` and `CRON_SECRET`, and that the workflow is
  enabled. Then dispatch `outbox-dispatch` manually to drain.
- **Both schedulers down:** fix either one; the backlog drains on
  the next run. If drains succeed but the age keeps growing, look at
  provider errors and `outbox_invocation` logs — the worker is
  running but delivery itself is failing (see
  [email not arriving](email-not-arriving.md)).
- **Dispatch secret suspect:** rotate `OUTBOX_DISPATCH_SECRET` —
  generate a new value, set it in Vercel Production, redeploy,
  update the header in cron-job.org right away. Expect one or two
  401 runs in between; GitHub covers that gap. See
  [rotating secrets](rotating-secrets.md).

Do not give `CRON_SECRET` to the external service: it also
authorizes `/api/cron/weekly`, which publishes pairings.

## Verify

```bash
curl -s https://randoricircle.com/api/cron/outbox-health \
  -H "Authorization: Bearer $OUTBOX_DISPATCH_SECRET"
# Expect oldestDueAgeMs under 15 minutes and falling.
```

Confirm the next hourly watchdog run is green. Note the timeout
quirk: cron-job.org's free plan times out at 30 s while the handler
budget is 45 s, so under backlog cron-job.org may report a timeout
while the function keeps going. That does not break delivery — the
next run picks up anything left after the lease expires. If timeouts
happen often, check the health endpoint before changing anything.
