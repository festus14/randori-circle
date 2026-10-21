# Circle health for owners

Status: implemented behind `CIRCLE_HEALTH_ENABLED` (default off). No
migration, no new table, no new index. Issue #292, decision
[ID-73](IMPLEMENTED_DECISIONS.md#id-73-show-owners-aggregate-circle-health-from-existing-tables-behind-a-flag).
The visual design is provisional (`needs-design`).

## What it is

An owner-only **Circle health** card at the bottom of the Circle tab. It shows
one row per cycle for the last 8 published cycles of the selected circle,
newest first, so an owner can see where the weekly loop drops off:
availability, pairing, agreeing a time, or the session itself. Every number is
a total for the whole circle. There are no per-member rows, no client events,
no cookies and no third-party scripts; the CSP is unchanged.

## Flag and capability

`CIRCLE_HEALTH_ENABLED=true` (and `CIRCLE_MEMBERSHIP_ENABLED=true`, because
owners exist only with circle membership) turns on, together:

- the route: `GET /api/circle/health` returns `404 {"error":"not found"}` and
  touches no storage while the flag is off;
- the capability: `GET /api/auth/capabilities` adds `circleHealth: true`; the
  browser shows the card only with this capability and an owner role, and the
  server still checks ownership on every read.

## API contract

`GET /api/circle/health` (Vercel rewrite to `/api/ops?endpoint=circle-health`;
`scripts/local-server.mjs` routes it the same way). No body and no query
parameters: the circle is the session's selected circle, never a parameter.
With the multi-circle control plane on, send
`x-randori-circle-context-version` as for every other selected-circle request.

| Status | Body | When |
| --- | --- | --- |
| 200 | see below | active owner of the selected, unarchived circle |
| 400 | `{"error":"invalid request"}` | any query parameter other than the rewrite's `endpoint` |
| 401 | `{"error":"authentication required"}` | no live session |
| 403 | `{"error":"circle owner required"}` | member, demoted owner, inactive owner, archived circle, or a circle the caller does not own |
| 404 | `{"error":"not found"}` | flag (or circle membership) off |
| 405 | `{"error":"GET only"}` + `Allow: GET` | any other method |
| 409 | `{"code":"active_circle_required"}` or `{"code":"circle_context_changed"}` | multi-circle: nothing selected (including a selected circle that was archived), or a stale context header |
| 503 | `{"error":"circle health unavailable"}` | storage failure; the server logs only an error code |

Responses are `Cache-Control: private, no-store`.

```json
{
  "ok": true,
  "circle_context_version": 3,
  "health": {
    "version": 1,
    "scope": "primary",
    "window_cycles": 8,
    "lookback_cycles": 8,
    "min_cell_size": 3,
    "completion_tracked": true,
    "attendance_outcomes_tracked": false,
    "generated_at": "2026-10-20T12:00:00.000Z",
    "cycles": [
      {
        "cycle_id": "2026-W43",
        "starts_at": "2026-10-18T07:00:00.000Z",
        "in_progress": true,
        "suppressed": false,
        "metrics": {
          "available": {"status": "ok", "value": 7},
          "paired": {"status": "ok", "value": 6},
          "solo": {"status": "suppressed", "value": null},
          "scheduled": {"status": "suppressed", "value": null},
          "completed": {"status": "suppressed", "value": null},
          "cancelled": {"status": "not_tracked", "value": null},
          "no_show": {"status": "not_tracked", "value": null},
          "median_hours_to_agreed_time": {"status": "ok", "value": 95},
          "repeat_pair_percent": {"status": "ok", "value": 100}
        }
      }
    ]
  }
}
```

`circle_context_version` is present only with the multi-circle control plane.
Every cell is `{status, value}` where `status` is `ok` (value is a number),
`suppressed`, `no_data` (nothing to measure, for example a median with no
agreed times) or `not_tracked`. `suppressed: true` on a cycle means the whole
cycle is withheld.

## Metrics

All counts are **members**, so every stage of the funnel uses the same unit.

| Metric | Primary circle | Secondary circle |
| --- | --- | --- |
| `available` | members in the published week (`pairing_participants`) | members placed in a group (`circle_pairing_groups`) |
| `paired` | members of two- or three-person groups | members of two-person groups |
| `solo` | odd member (legacy AI/solo group) | `is_solo` group |
| `scheduled` | paired members whose pair has an agreed time (`pair_schedules.agreed_time`; a legacy free-text agreement counts) | paired members with `circle_pair_schedules.agreed_time` |
| `completed` | paired members whose pair has a unanimous completion receipt set (same rule as `/api/stats`, ID-55) | `not_tracked`: secondary circles have no completion capability |
| `median_hours_to_agreed_time` | median hours from publication (`pairing_week_runs.created_at`, else the week's `created_at`) to the agreed session instant, over pairs with a valid instant | same, from `circle_pairing_publications.created_at` |
| `repeat_pair_percent` | share of human pairs whose members were also grouped together in any of the 8 published cycles before | same |
| `cancelled`, `no_show` | `not_tracked` until #291 | `not_tracked` until #291 |

Notes:

- "Time from pairing to agreed time" is measured to the **agreed session
  time**. When the pair agreed is not stored: `pair_schedules.updated_at`
  changes on every later proposal, so "time to agree" would need a schema
  change.
- Only weeks with an ISO label (`YYYY-Www`) and `is_demo=0` count; demo seeds
  and unmanaged legacy labels are skipped.
- The in-progress marker compares the cycle id with the current cycle in
  `PAIRING_TIME_ZONE`.

## Privacy: small-cell suppression

Enforced in `api/_circle-health.js` before the response is built; the browser
only displays what it is given. The threshold is `min_cell_size = 3`.

1. **Cycle floor.** A cycle with 1 or 2 available members is withheld whole.
2. **Counts.** A count of 1 or 2 members is suppressed; 0 is shown.
3. **Complements.** `scheduled` is also suppressed when `paired − scheduled`
   is 1 or 2, and `completed` when its difference from `paired` or
   `scheduled` is 1 or 2, so a hidden value cannot be recovered by
   subtraction (6 paired and 4 scheduled would reveal that exactly one pair
   did not agree a time).
4. **Rates and medians.** `repeat_pair_percent` needs at least 3 paired
   members and both the repeat and the non-repeat members to be 0 or at least
   3. The median needs at least 3 contributing members (so one pair can never
   expose its own timing). Medians are rounded to 0.1 h.
5. **Parity.** `solo` follows rule 2 although the parity of `available`
   implies it. The published pairing already shows every member who practised
   solo, so this reveals nothing new.

The response contains no ids, names or emails. Review the threshold with the
owner before turning the flag on (issue #292 "Dependencies / risks").

Residual risk: the in-progress cycle's numbers change as pairs act, so an
owner who compares two views can tell that some pair just agreed a time or
completed, without learning which pair. Closed cycles do not change.

## Authorization

The route resolves the circle exactly like `/api/members`: the selected circle
from the live session (multi-circle) or the caller's primary circle. It then
requires an **active owner** row for that circle, which must not be archived.
Any number of owners may read it (ID-69). The owner check is the first
statement of the read batch **and** a guard CTE inside every data statement, so
a demotion or archive between the checks and the read still returns 403 and no
aggregate leaves the database.

## Read budget

Per request: the session check (plus the circle-context read with the
multi-circle control plane), one owner check, and one `read` batch (a single
snapshot). Plans were confirmed with `EXPLAIN QUERY PLAN` on a migrated
database. N is the circle's members per cycle.

| Statement | Index | Rows read (about) |
| --- | --- | --- |
| owner check (twice) | `idx_circle_memberships_circle_active`, circle by rowid | 2 |
| primary weeks (16) | descending scan of `idx_pairing_weeks_week_label`, `pairing_week_runs` by primary key | 16 + skipped demo weeks |
| primary participants (8 weeks) | `uq_pairing_participants_completion_owner` (covering) | 8·N |
| primary groups (16 weeks) | **none: full scan of `pairing_groups`** | every stored group |
| primary schedules (8 weeks) | `uq_pair_schedules_meeting_agreement` (covering) | ≤ 4·N |
| primary receipts (8 weeks) | `session_completion_receipts` primary key | ≤ 8·N |
| secondary publications (16) | `idx_circle_pairing_publications_circle_cycle` | 16 |
| secondary groups (16) | `circle_pairing_groups (publication_id, …)` | ≤ 8·N |
| secondary schedules (8) | `circle_pair_schedules (publication_id, group_id)` | ≤ 4·N |

**Missing index.** `pairing_groups` has no `week_id` index, so the primary
group read scans the table (about N/2 rows per published week ever; a
12-member circle adds about 300 rows a year). `/api/stats`, history and the
publication read already scan it the same way. No DDL is added here; a future
managed migration could add `CREATE INDEX … ON pairing_groups(week_id)`.

**Caching.** Nothing is cached on the server or in a table. Within a request,
pair keys are computed once per cycle and reused by every later cycle's
lookback. The browser loads the card only while the Circle view is on screen,
keeps one copy per account and circle context for 5 minutes (Refresh refetches;
publishing a cycle in that tab drops the copy), and clears it on any identity
or circle change.

## Seam for cancellations and no-shows (#291)

`cancelled` and `no_show` are already in the contract as `not_tracked`, and
`attendance_outcomes_tracked` is `false` (`ATTENDANCE_OUTCOMES_TRACKED` in
`api/_circle-health.js`). When #291 stores cancel and no-show records, it
should: add one guarded statement per scope to the read batch, count members
per cycle in `aggregateCycle`, route those counts through `countCell` with the
same complement rule against `paired`, flip the constant, and add the columns
to `METRICS` in `assets/circle-health.js` (the card's footnote disappears
automatically).

## Rollout and recovery

1. Merge with the flag unset: nothing changes (no route, no capability, no
   card). No migration or readiness change.
2. Agree the suppression threshold with the owner.
3. Set `CIRCLE_HEALTH_ENABLED=true` in Vercel Production and redeploy.
4. To recover, unset the flag and redeploy; there is no stored state to clean
   up.

## Tests

- `tests/unit/circle-health.test.mjs`: a 17-week hand-built primary history
  (demo, legacy and lookback-only weeks, a triad, a legacy free-text
  agreement) and secondary circles; every suppression rule; owners,
  co-owners, demoted, inactive, archived and cross-circle callers; a demotion
  racing the read.
- `tests/unit/circle-health-api.test.mjs`: route wiring through the ops
  handler with the real active-circle module.
- `tests/unit/circle-health-ui.test.mjs`: response validation and the card
  controller.
- `tests/e2e/golden-circle-health-real-runtime.spec.ts`: golden path 15 in
  [`E2E_GOLDEN_PATHS.md`](testing/E2E_GOLDEN_PATHS.md).
