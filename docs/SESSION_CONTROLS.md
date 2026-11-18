# Durable pair session controls

## Product contract

The primary two-person workspace has one shared 25-minute focus timer and one
candidate assignment. Both authenticated participants read the same durable
state from `GET /api/session-controls?room_id=week_<week>_pair_<group>` and use
exact `POST /api/session-controls` commands:

- `{room_id, action:"start", base_version}`;
- `{room_id, action:"pause", base_version}`;
- `{room_id, action:"reset", base_version}`;
- `{room_id, action:"set_candidate", base_version, candidate_user_id}`.

The session supplies the actor; the body cannot choose or impersonate one.
Responses are private and non-cacheable. An absent room, an unauthorized room,
an AI assignment, a triad, a mixed-source pair, and a secondary coordination
room all return the same 404 projection. The payload identifies only the two
already-visible pair members and their current roles. It contains no code,
board, chat, meeting URL, provider data, completion receipt identity, or timer
event history.

The browser displays an accessible Session controls region. Its status live
region announces starts, pauses, resets, role changes, errors, expiry, and the
terminal transition—not countdown ticks. The browser animates the most recent
server duration locally, polls around two seconds while running and five
seconds otherwise, and stops work while hidden, signed out, deactivated, or
terminal. Requests are fenced by authenticated account, canonical room,
primary circle/context, cycle identity, request generation, control version,
and completion version.

## Storage, time, and concurrency

Migration 19 owns `pair_session_controls`, one row per canonical primary pair.
It stores the exact two-member, `auth`-source pair snapshot, the candidate,
durable timer state, remaining milliseconds at the last transition, a nullable
database-time anchor, a monotonic revision, and the last authenticated actor.
Composite foreign keys and migration-owned triggers provide NULL-safe shape,
source and actor binding, and atomically invalidate controls if pair membership
or participant provenance changes. The table permits only a paused timer with
no anchor or a running timer with a positive duration and canonical anchor.

Start, pause, reset, and role assignment execute in serialized write
transactions. Every non-idempotent transition compares an opaque HMAC token
which binds the pair snapshot and complete durable aggregate. The token
deliberately excludes derived display time, so reading a running timer does not
create spurious conflicts. Repeating an already-achieved command is a no-write
success; competing different commands produce one winner and a stable 409 with
the latest safe projection.

Elapsed time is derived from SQLite/Turso UTC time, never the browser or an
application-instance clock. There are no per-second writes. Natural expiry
only makes the timer expired; it never records completion. Once all required
participants have completed the session under migration 17, every control
command is rejected and the effective timer is capped at the unanimous
completion instant. Reads remain available as a read-only terminal summary.

## Rollout and rollback

1. Rehearse the additive v18 to v19 migration against a disposable restore.
2. Apply exactly migration 19 through the protected production migration
   workflow before deploying the handler and UI.
3. Canary two authenticated browsers for role/timer convergence, stale and
   simultaneous commands, natural expiry, terminal completion, sign-out,
   circle/room changes, and process restart recovery.
4. Confirm runtime SQL contains no DDL and countdown animation produces no
   writes. Monitor only generic endpoint error/status aggregates.

Migration 19 synthesizes no state from legacy local-storage timers or role
buttons. Its invalidation triggers also let a rolled-back v18 binary change a
pair or run its older demo-reset order without retaining stale controls. A
rollback keeps the table, triggers, and ledger row, disables the handler/UI if
needed, and rolls forward. It must not drop the table or rewrite migration
history. The v19 runtime explicitly deletes demo-week control rows first.

## Interview first increment (#464)

Decision: ID-95 in [the implemented decision log](IMPLEMENTED_DECISIONS.md#id-95-scope-primary-interview-controls-to-the-interviewer-and-close-on-timer-expiry).

`INTERVIEW_SESSION_ENABLED` is optional, non-secret and **off unless exactly
`true`**. With it off, the existing peer controls, response shape, resettable
focus blocks, and completion contract above are unchanged. The flag is
advertised only in authorized primary-room controls (`interview_mode:true`),
not in public capabilities. Secondary workspaces retain their peer behavior.

With it on:

- The existing candidate assignment is authoritative. Without a stored row,
  pair slot A is candidate and slot B is interviewer. Only the **current**
  interviewer can start, pause, reset, assign the candidate, or submit the new
  exact command `{room_id, action:"end", base_version}`. Assigning themselves
  candidate deliberately hands interviewer authority to the partner. The old
  interviewer loses powers immediately; a candidate cannot change the roles,
  even with a fresh token or an idempotent command. Authorization happens in
  the serialized transaction **before** idempotency, CAS or terminal checks.
  Denied commands return the same private `404 {error:"pair not found"}` as
  absent and unauthorized rooms. Actor/role fields in the body are rejected.
- Authorized projections add `interview_mode`, `can_control`, and `end_reason`
  (`null`, `interviewer_ended`, `timer_expired`, or `completed`). Control HMACs
  use a separate domain so peer-mode tokens cannot authorize interview writes.
- Start is manual and begins/resumes the existing 25-minute timer. Pause
  preserves database-derived remaining time; reset is permitted **only before
  terminal state** and starts another full, paused block. End is irreversible
  while this mode is enabled: it writes the already-supported paused timer
  with zero remaining time and no anchor. Natural expiry derives terminal
  state from the running anchor, including when no browser was present.
  It needs no cron, per-tick write or new schema. Every terminal command,
  including a repeated end, returns a stable 409; no reset can reopen it.
  Every control INSERT/UPDATE and CRDT create/update/workspace projection repeats
  the database-time boundary **in the storage statement**, since time can advance
  inside a serialized transaction. A rejected fence reports terminal state and
  rolls back the entire transaction, including any earlier document bootstrap.
- Late browsers read the same timer/end state after restart. The browser does
  not assert expiry from its own clock: when its local animation reaches zero
  it reconciles with the database boundary before entering terminal state.
- End/expiry closes CRDT reads/merges and new room execution lookups. Workspace
  snapshot writes repeat the boundary in SQL so an early-end race cannot
  publish another checkpoint. Already-authorized executions may finish within
  their existing bounded provider lifetime; this increment does not cancel a
  provider job already running. Read-only workspace snapshots remain available.
- A terminal observation stops countdown and control/receipt polling, aborts
  workspace polling/saves, closes CRDT work, disposes the call and stops chat,
  schedule and run-feed reconciliation in that browser. Scope/identity fences
  prevent delayed responses from reopening it. Wrap-up remains usable: each
  participant confirms their **own** receipt through the unchanged completion
  endpoint; **Refresh completion** is explicit after end. An interrupted hidden-tab
  confirmation releases its busy/disabled UI without restarting polling; a delayed
  aborted response cannot change the receipt display. Refresh reconciles whether
  the server accepted that interrupted confirmation. Ending a room never
  fabricates the partner's receipt and never increments completion metrics.

**Rollout:** no migration or new provider/secret. Use the existing migrated
schema. Canary a fresh primary pair with the flag on; verify A/B roles,
interviewer-to-candidate handoff, start/pause/reset, early end, natural expiry,
late joins, sign-out, and both completion confirmations. A running or already
expired *existing* focus timer is interpreted by these same rules when the
flag is enabled; choose the canary deliberately, not a live peer practice.

**Rollback:** set the flag off and redeploy. Stored controls and receipts stay
intact, but controls return to symmetric peer behavior and an expired timer
can be reset again. A page already in terminal summary needs a reload to pick
up the changed mode. This flag is a deployment-wide mode for eligible primary
pairs, not a durable per-room opt-in; do not toggle it mid-interview.

**Remaining scope (Part of #464):** lobby/admission, schedule-driven auto-start,
interviewer-owned question selection, and lock/unlock of candidate editing.
The current question-selection and pre-terminal editing APIs remain peer
capabilities; this increment does **not** claim those are interviewer-only.

## Alternatives considered

| Option | Advantage | Why not now |
| --- | --- | --- |
| Workspace snapshot v4 | One existing synchronization channel | Couples tiny role/timer edits to large code/board payloads, conflicts, and cleanup |
| Local storage or `BroadcastChannel` | No server or schema work | Neither is durable or cross-device, and both can leak state across account/room transitions |
| WebSocket, WebRTC, or LiveKit state | Lower-latency notifications | Connection and provider lifecycle become the source of truth; a durable aggregate is still required |
| Redis/KV with TTL | Fast shared countdown | Adds provider, secret, cost, expiry, and recovery dependencies for a small durable record |
| Event sourcing | Complete transition history | Creates unnecessary retention and privacy surface for controls that need only current state |
| Persist each countdown tick | Trivial reads | Causes write amplification and avoidable races; anchor-based database-time derivation is sufficient |
