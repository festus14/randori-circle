# Personal progress dashboard

Status: implemented behind `PROGRESS_DASHBOARD_ENABLED` (default off), no
migration. Issue #293, decision ID-72. The visual design is provisional
(`needs-design`).

## Product contract

A signed-in member opens **History** and, above their pairings, sees **Your
progress**: completed sessions, the current and longest weekly streak,
exercises solved, a 12-week chart of sessions and of verified runs, coverage of
every catalogue pattern (untouched ones included), and, once roles were
recorded, how often they were the candidate or the interviewer.

Everything is computed on the server per request from the member's own
records. The member never chooses whose progress is read. Owners and app
admins cannot read anyone else's progress. Nothing new is stored, so data
export (#302) needs no new source.

## API

`GET /api/progress` (rewritten to `/api/data?endpoint=progress`).

| Case | Response |
| --- | --- |
| Flag off | `404 {"error":"unknown data endpoint 'progress'",…}`, exactly as before the feature existed |
| Not signed in | `401 {"error":"authentication required"}` |
| Method other than GET | `405 {"error":"GET only"}` with `Allow: GET` |
| Any query key other than `user_id` (and the routing `endpoint`), a repeated key, or a malformed `user_id` | `400 {"error":"…"}` |
| `user_id` is anyone but the session user (existing or not) | `404 {"error":"progress not found"}` |
| Active circle is a secondary circle (multi-circle control plane) | the same `409 circle_feature_unavailable` History gets |
| Schema or database failure | `503 {"error":"progress unavailable"}` |
| Otherwise | `200`, `Cache-Control: private, no-store`, body below |

```json
{
  "ok": true,
  "user": {"id": 12},
  "generated_at": "2026-11-04T12:00:00.000Z",
  "time_zone": "Europe/London",
  "current_cycle": {"cycle_id": "2026-W45", "starts_at": "…", "ends_at": "…"},
  "sessions": {"completed": 4, "solo_completed": 1, "pairings": 6, "window_limited": false},
  "streak": {"rules_version": 1, "current_weeks": 2, "longest_weeks": 3, "this_week": "in_progress"},
  "weeks": [
    {"cycle_id": "2026-W34", "starts_at": "…", "ends_at": "…", "status": "completed",
     "completion": null, "verified_runs": 3, "passed_runs": 2}
  ],
  "runs": {"window_weeks": 12, "verified": 9, "passed": 6, "scan_limited": false},
  "coverage": {
    "exercises": {"total": 19, "attempted": 4, "solved": 3},
    "patterns": [{"key": "binary-search", "exercises": 1, "attempted": 1, "solved": 0}],
    "topics": [{"key": "arrays", "exercises": 4, "attempted": 2, "solved": 1}]
  },
  "roles": {"available": true, "sessions": 3, "candidate": 2, "interviewer": 1},
  "feedback": {"available": false}
}
```

- `weeks` holds the 12 most recent cycles, oldest first; the last entry is the
  current cycle. `completion` is `not_recorded` or `awaiting_participants` for
  `in_progress` and `not_completed` weeks, otherwise `null`.
- `roles` is `{"available": false}` until at least one completed session has
  shared session controls (migration 19).
- `feedback` is the seam for #290 (structured feedback). It stays
  `{"available": false}` until feedback is recorded.
- While the flag is on, `GET /api/history` adds `"progress": {"enabled": true}`.
  The History view imports `assets/progress-view.js` and calls `/api/progress`
  only then, so with the flag off no request or asset is added.

## Counts

- **Completed sessions** count the member's non-demo primary pairings whose
  completion receipts are unanimous, using the same projection as History,
  recap and `/api/stats` (`your_sessions`). A confirmed solo session counts.
  History also lists demo-week pairings; those are excluded here, as they are
  from `your_sessions`.
- **Pairings** count the same non-demo pairings, completed or not.
- `window_limited` is true if the member has more than 260 pairings; only the
  newest 260 are counted.

## Streak rules (version 1)

A week is one pairing cycle: Sunday 08:00 to the next Sunday 08:00 in
`PAIRING_TIME_ZONE` (the same boundary as availability and pairing, so DST
weeks stay consecutive). Each week gets one status, checked in this order:

| Status | When | Effect on the streak |
| --- | --- | --- |
| `completed` | a session with at least one partner was confirmed by every participant | counts |
| `not_available` | the member saved "Skip this cycle" for that cycle | pauses |
| `in_progress` | the current cycle, paired with a partner, not yet confirmed | neutral |
| `not_completed` | paired with a partner, the cycle has ended, and not everyone confirmed (also when there are no receipts at all) | ends the streak |
| `solo` | the member was the odd one out (solo pairing), confirmed or not | pauses |
| `no_pairing` | no pairing for the member that cycle (no publication, joined later, not included) | pauses |

The current streak counts `completed` weeks from the newest week backwards,
skipping pauses and the in-progress week, until the first `not_completed`
week. The longest streak is the longest such run. A completed session still
counts in a week the member had marked as skipped. Pairing weeks map to a cycle
by their cycle-id label (`2026-W45`), or by their start instant for older
labels. Cycles older than 260 weeks are not examined.

Copy never calls a week missed: paused weeks say "streak paused", a week
without receipts says "No session recorded", and one with some receipts says
"Not everyone confirmed".

## Runs and coverage

- A run counts only if it is the member's own and its server attestation
  verifies, using the same projection as the recap run feed. Runs from solo
  practice count.
- The 12-week chart buckets verified runs into the week containing their
  `created_at`. A run passed if every case passed.
- Coverage uses every verified run in the scan. Patterns are the catalogue
  `type`, topics are its `tags`. Every active exercise is listed, so untouched
  patterns and topics appear with zero. Runs of retired exercises are ignored
  for coverage.
- `scan_limited` is true if the member has more than 500 runs; only the newest
  500 are read.

## Roles

For each completed partnered session with shared session controls, the member
was the candidate if the stored `candidate_user_id` is theirs, otherwise the
interviewer. Only the last role set in the session is stored, so a session
where roles swapped counts once, with its final role.

## Turso budget

One request makes one clock read and one read batch of five bounded statements:
the member's pairings (`LIMIT 261`), their receipts and session controls (joined
to those pairings), their skip decisions in the primary circle since the oldest
examinable cycle (`LIMIT 260`), and their newest runs through `idx_runs_user`
(`LIMIT 501`). There is no new table, index, migration, cache or background
job, and no DDL on the request path.

## Interface

- History: the `#historyProgress` section (`data-testid="progress-dashboard"`)
  above the pairings. Stat tiles, two charts, a table of the same weeks, pattern
  rows with a badge (Solved, Partly solved, Tried, Not started), all topics in a
  disclosure, and interview roles when available. Loading, error with Retry, and
  a new-member empty state.
- Charts are simple SVG drawn with design tokens and marked `aria-hidden`. Each
  has a text summary next to it, and **Show weeks as a table** lists every week's
  status, verified runs and passes. The table and the topic list are native
  `<details>` elements, so the section is keyboard complete.
- Requests are fenced by member, epoch and visibility, like the rest of
  History. Rendering uses DOM nodes and `textContent` only.

## Deferred

- **Weekly summary line in the pairing email.** Optional in the issue. It would
  need progress reads per recipient inside the outbox worker's time budget and a
  new notification-preference rule. Left for a follow-up behind this flag.
- **Feedback trends by rubric dimension.** Depends on #290; the `feedback` seam
  is in place.
- **Final layout and copy.** The issue is `needs-design`.

## Rollout and recovery

Merge with the flag unset: nothing changes for users. To enable, set
`PROGRESS_DASHBOARD_ENABLED=true` in Vercel Production and redeploy. To turn it
off, unset it and redeploy. Nothing is written, so there is nothing to clean up.
