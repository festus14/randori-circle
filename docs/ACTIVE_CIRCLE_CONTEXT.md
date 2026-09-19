# Active-circle control plane

This increment makes multi-circle membership safe for roster and invitation
management without pretending that pairing data is tenant-scoped already. It is
disabled unless both `CIRCLE_MEMBERSHIP_ENABLED=true` and
`MULTI_CIRCLE_CONTROL_PLANE_ENABLED=true`.

## Contract

- `GET /api/circles` lists only the caller's active, non-archived memberships.
  It returns the selected circle, the current context version, and
  `selection_required` when a multi-circle session has not selected one.
- `PUT /api/circles` accepts exactly `circle_public_id` and
  `expected_context_version`. Selection is a same-origin, compare-and-swap
  mutation. An outdated version returns `409 circle_context_changed`.
- Migration v12 owns `auth_session_circle_contexts`, keyed by the
  hashed live session. Client-provided public IDs select a candidate; active
  membership is still rechecked in the write transaction and on every use.
- After an explicit multi-circle selection, circle/member/invitation requests carry
  `X-Randori-Circle-Context-Version`. A missing or stale version fails with
  `409 circle_context_changed`; the header is concurrency context, never an
  authorization grant. Implicit single-circle requests require no new header.
- A single-circle session continues to use its only active membership without a
  selection write when it has no stored context. If a formerly selected circle
  becomes inactive, the preserved generation requires explicit reselection even
  when only one circle remains. Existing behavior is unchanged while the
  feature flag is off.
- `/api/circle`, `/api/members`, and `/api/invitations` resolve the selected
  context server-side. Owner writes recheck the exact circle, role, target, and
  archive state. Roster cursors remain encrypted and circle-bound.
- Leaving or removing one membership bumps affected context generations and
  revokes account sessions only when no active circle remains. The context row
  remains as a tombstone, so reactivation cannot make an old version valid.
- Pairing, availability, history, schedule, chat, execution, workspace, video,
  and AI routes are available only when the session resolves to exactly one
  active primary circle. Multiple circles, a sole secondary circle, or a stale
  saved selection return `409 circle_feature_unavailable`; these records do not
  yet carry complete tenant ownership.

The browser clears private circle and workspace state before reloading after a
switch. It broadcasts the context change to other tabs so delayed circle-A
responses cannot render under circle B.

## Rollout

1. Apply managed migration v12 after the protected migration and
   restore rehearsals required by issues #38 and #43.
2. Deploy with `MULTI_CIRCLE_CONTROL_PLANE_ENABLED=false`; verify health and
   ordinary single-circle login, roster, invitation, and pairing behavior.
3. Enable the flag in staging. Create a fixture account with two active circle
   memberships and verify selection, cross-tab reload, scoped roster/invitation
   operations, last-owner rules, and the explicit pairing/workspace 409.
4. Repeat the control-plane checks in production before admitting a real
   secondary membership. Monitor only aggregate response/error counts; circle
   names, invitation targets, and session identifiers must not enter telemetry.

Rollback is application-only: disable the flag. The additive context rows can
remain. Existing single-primary behavior resumes, and no membership or tenant
data is deleted.

## Deferred work

Circle creation/archive and secondary-circle coordination remain separate
increments. Pairing weeks, participants, schedules, messages, runs, snapshots,
video, AI, notification idempotency, and associated foreign keys must gain
canonical `circle_id` ownership before their secondary-circle flags can be
enabled. Postgres with row-level security remains the preferred final tenancy
boundary; a Turso retrofit remains possible but requires table rebuilds and
application-enforced authorization.
