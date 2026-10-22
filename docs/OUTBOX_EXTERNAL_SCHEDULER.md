# Outbox external scheduler (cron-job.org)

Decision: [ID-67](IMPLEMENTED_DECISIONS.md#id-67-run-an-external-outbox-scheduler-beside-github-and-alert-on-delivery-health)

## Why

`POST /api/cron/outbox` drains the durable email outbox. The checked-in
`outbox-dispatch` GitHub workflow is scheduled every five minutes, but GitHub
often runs it only every few hours. Auth and invitation mail is not affected
(it is sent right after commit, ID-64). Weekly pairing mail, reminders and
retries can arrive hours late.

An outside scheduler (cron-job.org) now calls the same endpoint every five
minutes, and GitHub keeps running as a backup. Running both at once is safe.
Each claim is a lease-based, idempotent database update, so two dispatchers
never send the same delivery key twice. The unit test "multiple workers drain
real SQLite concurrently with one visible delivery per key" covers this.

## Credential: `OUTBOX_DISPATCH_SECRET`

Do not give `CRON_SECRET` to the external service. That secret also authorizes
`/api/cron/weekly`, which publishes pairings.

`OUTBOX_DISPATCH_SECRET` is an optional Vercel environment variable that only
works on the outbox routes:

| Route | `CRON_SECRET` | `OUTBOX_DISPATCH_SECRET` |
| --- | --- | --- |
| `POST`/`GET /api/cron/outbox` | yes | yes |
| `GET /api/cron/outbox-health` | yes | yes |
| `/api/cron/weekly` and every other cron route | yes | **no** |

The app ignores the variable, rejecting only this extra secret, if it is
shorter than 32 characters or identical to `CRON_SECRET`. The comparison is
timing-safe and accepts the same header forms as `CRON_SECRET`:
`Authorization: Bearer <secret>` or `x-cron-secret: <secret>`.

Generate it with `openssl rand -hex 32`. Put it in Vercel Production as
`OUTBOX_DISPATCH_SECRET`, then redeploy. Put it in cron-job.org and nowhere
else. It does not belong in GitHub.

## cron-job.org setup

Create one cron job:

| Field | Value |
| --- | --- |
| URL | `https://randoricircle.com/api/cron/outbox` |
| Request method | `POST` |
| Headers | `Authorization: Bearer <OUTBOX_DISPATCH_SECRET>` |
| Request body | none |
| Schedule | every 5 minutes (`*/5 * * * *`) |
| Timeout | the maximum the plan allows (free plan: 30 s) |
| Treat as failure | any non-2xx response |
| Notifications | turn on failure notifications (and "job disabled" notifications) to the owner email |
| Save responses | optional. The response holds only aggregate counters |

About the timeout: the handler budget is 45 s (`OUTBOX_CRON_BUDGET_MS`), which
is longer than cron-job.org's free 30 s timeout. When the outbox is empty, the
drain returns in well under a second. Under backlog, cron-job.org may report a
timeout while the function keeps going. That does not break delivery. Every
claim is a lease, so the next run, from either scheduler, picks up anything
left unfinished after the lease expires. If timeouts happen often, check the
health endpoint before you change anything.

Check the job by running it once from cron-job.org ("Test run"). Expect HTTP
200 and `{"ok":true,...,"outbox":{...}}`. A 401 means the secret is wrong,
too short, or not deployed. A 503 means the app's outbox or database is not
available.

### Moving the job to the canonical domain (ID-80)

Jobs created before ID-80 call
`https://randori-circle-self.vercel.app/api/cron/outbox`. That URL keeps
working: the old alias redirects page paths only and still serves `/api/*`
directly, so the `POST` and its `Authorization` header arrive unchanged.
Change the URL to `https://randoricircle.com/api/cron/outbox` right after the
canonical-domain deploy (step 5 of
[the switch order](PRODUCTION_BOOTSTRAP_GUIDE.md#switch-order)), keep the
header and schedule as they are, then do a "Test run" and expect HTTP 200. On
a rollback the job can stay on either URL.

## Delivery health

`GET /api/cron/outbox-health` takes either secret. It is read-only and returns
only aggregate values (`Cache-Control: no-store`):

```json
{
  "ok": true,
  "checkedAt": "2026-10-19T12:00:00.000Z",
  "oldestDueAgeMs": 42000,
  "dueCount": 3,
  "processingStaleCount": 0,
  "oldestStaleLeaseAgeMs": null,
  "deadLetterCount": 0,
  "deadLetterWindowMs": 86400000,
  "lastDeliveredAt": "2026-10-19T11:58:12.345Z"
}
```

- `oldestDueAgeMs`: time since the oldest `pending`/`retry` event became due,
  measured from the later of `not_before` and `next_attempt_at`. `null` if
  nothing is due.
- `dueCount`: number of due `pending`/`retry` events.
- `processingStaleCount` / `oldestStaleLeaseAgeMs`: `processing` events whose
  lease has expired, and how long ago the oldest one expired.
- `deadLetterCount`: events dead-lettered in the last `deadLetterWindowMs`
  (24 h).
- `lastDeliveredAt`: newest `delivered_at`, or `null`.

If the database is unavailable, the endpoint returns 503
`{"ok":false,"error":"outbox health unavailable"}`. It never returns payloads,
idempotency keys, recipients, or row ids.

The hourly `outbox-dispatch-watchdog` workflow alerts based on this endpoint.
It alerts when `oldestDueAgeMs` or `oldestStaleLeaseAgeMs` exceeds 15 minutes,
or when the endpoint is unavailable, unauthorized, or malformed. GitHub run
staleness is still reported, but only as a warning. See
[the watchdog runbook](OUTBOX_DISPATCH_WATCHDOG.md).

## GitHub stays as a parallel backup

Leave `.github/workflows/outbox-dispatch.yml` as it is. It keeps using
`CRON_SECRET` from the protected `production` environment. If cron-job.org
stops or is disabled, GitHub still drains the outbox whenever it runs, and the
watchdog alerts if mail goes stale. If GitHub is delayed, cron-job.org keeps
delivery fresh, and the watchdog shows only a `github_run_stale` warning.

## Rotate

1. Generate a new value and set it as `OUTBOX_DISPATCH_SECRET` in Vercel
   Production. Redeploy.
2. Update the header in cron-job.org right away. The old value stops working
   after the redeploy, so expect one or two 401 runs in between. GitHub covers
   that gap.
3. Run a test from cron-job.org and confirm HTTP 200.

## Disable

- Pause the job in cron-job.org, or
- remove `OUTBOX_DISPATCH_SECRET` from Vercel and redeploy. From then on every
  external call gets 401, and only `CRON_SECRET` callers (GitHub) can drain.

Neither step changes data or the schema. Delivery falls back to the GitHub
schedule.
