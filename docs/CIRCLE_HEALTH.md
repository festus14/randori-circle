# Circle health for owners

Status: implemented behind `CIRCLE_HEALTH_ENABLED` (default off). No
migration, no new table, no new index. Issue #292, decision
[ID-78](IMPLEMENTED_DECISIONS.md#id-78-show-owners-aggregate-circle-health-from-existing-tables-behind-a-flag).
The visual design is provisional (`needs-design`).

## What it is

An owner-only **Circle health** card at the bottom of the Circle tab. It shows
one row per cycle for the last 8 **settled** cycles of the selected circle
(cycles that ended at least 49 hours ago), newest first, so an owner can see
where the weekly loop drops off: availability, pairing, agreeing a time, or
the session itself. Every number is a total for the whole circle. There are
no per-member rows, no client events, no cookies and no third-party scripts;
the CSP is unchanged. The current cycle and the one that just ended are not
included (this week's pairs are on the Pairing tab), so watching the card
cannot show a pair acting in real time.

## Flag and capability

`CIRCLE_HEALTH_ENABLED=true` (and `CIRCLE_MEMBERSHIP_ENABLED=true`, because
owners exist only with circle membership) turns on, together:

- the route: `GET /api/circle/health` returns `404 {"error":"not found"}` and
  touches no storage while the flag is off;
- the capability: `GET /api/auth/capabilities` adds `circleHealth: true`;
- the card: `index.html` imports `/assets/circle-health.js` with `import()`
  only when the capability is on, the viewer owns the circle and the Circle
  view is on screen. With the flag off the module is never downloaded.

The server still checks ownership on every read.

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
| 503 | `{"error":"circle health unavailable"}` | storage failure or an invalid `PAIRING_TIME_ZONE`; the server logs only an error code |

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
    "min_pairs": 4,
    "completion_tracked": true,
    "attendance_outcomes_tracked": false,
    "generated_at": "2026-10-27T12:00:00.000Z",
    "cycles": [
      {
        "cycle_id": "2026-W43",
        "starts_at": "2026-10-18T07:00:00.000Z",
        "metrics": {
          "available": {"status": "ok", "value": 9},
          "paired": {"status": "ok", "value": 8},
          "solo": {"status": "ok", "value": 1},
          "pairs": {"status": "ok", "value": 4},
          "scheduled_pairs": {"status": "ok", "value": 4},
          "completed_pairs": {"status": "ok", "value": 2},
          "repeat_pair_percent": {"status": "suppressed", "value": null},
          "median_hours_to_agreed_time": {"status": "not_tracked", "value": null},
          "cancelled": {"status": "not_tracked", "value": null},
          "no_show": {"status": "not_tracked", "value": null}
        }
      }
    ]
  }
}
```

`circle_context_version` is present only with the multi-circle control plane.
Every cell is `{status, value}` where `status` is `ok` (value is a whole
number), `suppressed`, `no_data` (the cycle had no pairs) or `not_tracked`.

## Metrics

| Metric | Unit | Primary circle | Secondary circle |
| --- | --- | --- | --- |
| `available` | members | members in the published week (`pairing_participants`) | members placed in a group (`circle_pairing_groups`) |
| `paired` | members | members of two-person (or legacy three-person) groups | members of two-person groups |
| `solo` | members | odd member (legacy AI/solo group) | `is_solo` group |
| `pairs` | pairs | number of two- or three-person groups | number of two-person groups |
| `scheduled_pairs` | pairs | groups with an agreed time (`pair_schedules.agreed_time`; a legacy free-text agreement counts) | groups with `circle_pair_schedules.agreed_time` |
| `completed_pairs` | pairs | groups with a unanimous completion receipt set (same rule as `/api/stats`, ID-55), counting only receipts confirmed less than 48 hours after the cycle ended | `not_tracked`: secondary circles have no completion capability |
| `repeat_pair_percent` | % of pairs | groups whose members were also grouped together in any of the 8 settled cycles before | same |
| `median_hours_to_agreed_time` | | `not_tracked` (deferred, below) | `not_tracked` |
| `cancelled`, `no_show` | | `not_tracked` until #291 | `not_tracked` until #291 |

What pairs did is counted in **pairs**, because people act in pairs. Only
weeks with an ISO label (`YYYY-Www`) and `is_demo=0` count; demo seeds and
unmanaged legacy labels are skipped. A cycle is settled once its end plus
the 48-hour receipt grace and a 1-hour clock margin has passed: the server
reads only cycles before the one that contains "now minus 49 hours" in
`PAIRING_TIME_ZONE`.

**Deferred: time from pairing to agreement.** The issue asks for the median
time from pairing to an agreed time. The moment a pair agreed is not stored
(`pair_schedules.updated_at` changes on every later proposal). The earlier
median of publication-to-session time measured something else, and it leaked:
its status revealed a hidden agreed count, and its value revealed another
pair's private session time. It returns to the card only once a real
agreement timestamp exists and it can be released under the rules below.

## Privacy

Enforced in `api/_circle-health.js` before the response is built; the browser
only displays what it is given. `min_pairs` is 4.

1. **Settled cycles only.** The current cycle is never returned, and a cycle
   that ended appears only after 49 hours (below, "Late changes").
2. **Published pairing facts are shown.** `available`, `paired`, `solo` and
   `pairs` describe the published pairing, which every member of the circle
   saw when it was published.
3. **Pair floor.** In a cycle with 1 to 3 pairs, `scheduled_pairs`,
   `completed_pairs` and `repeat_pair_percent` are always hidden, whatever
   their value, so "hidden" carries no information. Three pairs is under the
   floor because the edge rule below would leave only 0 or 3 visible, and a
   shown 0 or 3 always discloses every pair.
4. **Edge counts.** With 4 or more pairs, a pair count is hidden when exactly
   one pair is in it or exactly one pair is out of it (a single pair is 2
   members, under the 3-member threshold). `repeat_pair_percent` follows the
   same rule on the number of repeat pairs. 0 and "every pair" stay visible.
5. **Agreed and completed together.** If either `scheduled_pairs` or
   `completed_pairs` is an edge count, both are hidden. Without this, an owner
   who assumes completed pairs also agreed a time could narrow one hidden
   count from the other shown one.

**What is guaranteed.** No hidden cell is determined by the rest of a single
response. `tests/unit/circle-health-privacy.test.mjs` runs the production code
over every state of every pair (agreed, completed, repeat) for 1 to 6 pairs,
with and without a legacy triad and a solo member, in two world models: any
combination of agreed and completed (how the product works), and an owner
who assumes completed implies agreed. For every distinct response it checks
that each hidden cell is still consistent with at least two true values. None
can be recovered.

**What is not hidden.** An owner also knows their own pair's state. A shown
count of 0 or "every pair" tells the owner that every pair did, or did not,
do that thing, so the state of each named pair follows. The same test checks
that this is the only way the owner learns another pair's state, and bounds
how often it happens: with 1 to 3 pairs never; with 4 to 6 pairs, another
pair's agreed, completed or repeat state is determined in 2.7% to 12.5% of
cases, every one of them a shown 0 or "every pair". A count in between never
determines a named pair. Members are told this (below).

**Late changes.** Completion receipts can be written for any past week, so
completion counts only receipts confirmed less than 48 hours after the cycle
ended, and a cycle appears only after that grace plus a 1-hour margin for
clock skew between the app and the database (`confirmed_at` is set by the
database). From the moment a cycle appears, a late confirmation cannot change
its completed count. Agreements have no history (`pair_schedules.updated_at`
changes on every later proposal), so they are read as they are now. If a
partner clears an agreement, or accepts a newly proposed future time, in a
past week's room after that cycle appears, its agreed count can change or
turn Hidden. An owner comparing the two views can then work out the new
count, and, with what the owner knows about the pairs, possibly which pair
changed. This needs a partner to act on a past week's room, which the product
does not prompt, so it should be rare.

**What members are told.** Suggested Privacy Policy copy (to be added when
#336 merges): "Circle owners see weekly counts for their circle: how many
members took part and were paired, and how many pairs agreed a time and
completed a session, including when that was all pairs or none. Counts that
could point to a single pair are hidden, and the owner never sees who did
what."

The response contains no ids, names or emails. Review the threshold with the
owner before turning the flag on (issue #292 "Dependencies / risks").

## Authorization

The route resolves the circle exactly like `/api/members`: the selected circle
from the live session (multi-circle) or the caller's primary circle. It then
requires an **active owner** row for that circle, which must not be archived.
Any number of owners may read it (ID-69). The owner check is the first
statement of the read batch **and** a guard CTE inside every data statement, so
a demotion, deactivation or archive between the checks and the read still
returns 403 and no aggregate leaves the database.

## Read budget

Per request: the session check (plus the circle-context read with the
multi-circle control plane), one owner check, and one `read` batch (a single
snapshot). Plans were confirmed with `EXPLAIN QUERY PLAN` on a migrated
database. N is the circle's members per cycle.

| Statement | Index | Rows read (about) |
| --- | --- | --- |
| owner check (twice) | `idx_circle_memberships_circle_active`, circle by rowid | 2 |
| primary weeks (16 settled) | range scan `week_label < bound` of `idx_pairing_weeks_week_label` | 16 + skipped demo weeks |
| primary participants (8 weeks) | `uq_pairing_participants_completion_owner` (covering) | 8·N |
| primary groups (16 weeks) | **none: full scan of `pairing_groups`** | every stored group |
| primary schedules (8 weeks) | `uq_pair_schedules_meeting_agreement` (covering) | ≤ 4·N |
| primary receipts (8 weeks) | `session_completion_receipts` primary key | ≤ 8·N |
| secondary publications (16 settled) | `idx_circle_pairing_publications_circle_cycle` | 16 |
| secondary groups (16) | `circle_pairing_groups (publication_id, …)` | ≤ 8·N |
| secondary schedules (8) | `circle_pair_schedules (publication_id, group_id)` | ≤ 4·N |

**Missing index.** `pairing_groups` has no `week_id` index, so the primary
group read scans the table (about N/2 rows per published week ever; a
12-member circle adds about 300 rows a year). `/api/stats`, history and the
publication read already scan it the same way. No DDL is added here; a
`pairing_groups(week_id)` index stays on the backlog for a future managed
migration.

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
should: add one guarded statement per scope to the read batch, count pairs per
cycle in `aggregateCycle`, hide them with the same pair floor and edge rule
(and decide whether they must be hidden together with agreed and completed),
extend `tests/unit/circle-health-privacy.test.mjs` with the new per-pair
states, flip the constant, and add the columns to `METRICS` in
`assets/circle-health.js`.

## Rollout and recovery

1. Merge with the flag unset: nothing changes (no route, no capability, no
   card, no module download). No migration or readiness change.
2. Agree the suppression threshold with the owner.
3. Set `CIRCLE_HEALTH_ENABLED=true` in Vercel Production and redeploy.
4. To recover, unset the flag and redeploy; there is no stored state to clean
   up.

## Tests

- `tests/unit/circle-health-privacy.test.mjs`: the exhaustive privacy
  property above.
- `tests/unit/circle-health.test.mjs`: a hand-built primary history (current,
  demo, legacy and lookback-only weeks, a triad, a legacy free-text
  agreement, receipts inside and after the grace) and secondary circles;
  every suppression rule; the 49-hour boundary; a late confirmation that must
  not change a shown count; owners, co-owners, demoted, inactive, archived
  and cross-circle callers; demotion, deactivation and archive racing the
  read; a receipt from outside a pair.
- `tests/unit/circle-health-api.test.mjs`: route wiring through the ops
  handler with the real active-circle module, including a 503 for an invalid
  `PAIRING_TIME_ZONE`.
- `tests/unit/circle-health-ui.test.mjs`: response validation and the card
  controller, including a refused circle context that must not leave the card
  stuck.
- `tests/e2e/golden-circle-health-real-runtime.spec.ts`: golden path 18 in
  [`E2E_GOLDEN_PATHS.md`](testing/E2E_GOLDEN_PATHS.md).
