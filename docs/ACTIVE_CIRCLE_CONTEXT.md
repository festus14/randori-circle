# Active-circle control plane

This runbook defines the selected-circle control plane used by roster,
invitation, availability, coordination, and scheduling increments. Its base is
disabled unless both `CIRCLE_MEMBERSHIP_ENABLED=true` and
`MULTI_CIRCLE_CONTROL_PLANE_ENABLED=true`; dependent capabilities remain
separately default-off.

## Contract

- `GET /api/circles` lists only the caller's active, non-archived memberships.
  It returns the selected circle, the current context version, and
  `selection_required` when a multi-circle session has not selected one.
- `PUT /api/circles` accepts exactly `circle_public_id` and
  `expected_context_version`. Selection is a same-origin, compare-and-swap
  mutation. An outdated version returns `409 circle_context_changed`.
- `POST /api/circles` accepts only an exact bounded name and opaque request ID.
  Migration v14 binds one durable receipt to the exact account, session, name,
  circle, audit, and returned generation. Creation and selection commit in one
  transaction; see `CIRCLE_CREATION.md`.
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
- Dated availability has an independent, default-off rollout flag:
  `MULTI_CIRCLE_AVAILABILITY_ENABLED`. When both flags are enabled,
  `GET/POST /api/settings/availability` derive the circle only from the live
  session selection. Explicit contexts require the exact
  `X-Randori-Circle-Context-Version`; both methods revalidate the live session,
  membership, circle, and generation inside their write transaction before GET
  may materialize a cycle or POST may write a decision. Successes and
  same-context conflicts echo `circle_context_version` for browser fencing.
- Primary-circle first use retains the one-time legacy account-value bridge.
  A secondary circle starts at `cycle_default` even when it has no prior cycle;
  its availability key and decision rows are independent. This uses the
  existing v3 cycle tables and requires no migration after v12.
- With the additional default-off `SECONDARY_CIRCLE_COORDINATION_ENABLED` flag,
  `/api/pairing/run`, `/api/weeks`, and `/api/my-pair` use the selected circle.
  A selected primary retains the legacy workspace path. A selected secondary
  uses the v13 immutable coordination data plane and returns no room or other
  workspace capability. After v16, the additional default-off
  `SECONDARY_CIRCLE_SCHEDULING_ENABLED` flag adds only an opaque schedule
  identity and dashboard scheduling; it grants no room or workspace authority.
  History, chat, execution, workspace, video, recap, AI, and schedule email
  remain primary-only and return `409 circle_feature_unavailable`. See
  `SELECTED_CIRCLE_PAIRING.md` and `SECONDARY_SCHEDULING.md`.

The browser clears private circle and workspace state before reloading after a
switch. Starting a switch advances a client control-plane epoch, so delayed
roster, invitation, and member-mutation completions cannot restore circle-A
state while the switch is pending. The browser also broadcasts the committed
context change to other tabs so delayed circle-A responses cannot render under
circle B. Availability values, requests, saves, notices, and rollover timers
are fenced by account, circle public ID, and context generation. A refresh that changes the signed-in identity establishes a fresh
control-plane epoch and releases an obsolete pending-switch latch without
accepting its callback; a routine same-user refresh cannot cancel a commit.
During an OAuth recent-auth return, the pending lifecycle action survives that
refresh only until its actor, circle, context version, and TTL are revalidated.

## Rollout

1. Apply managed migration v12 after the protected migration and
   restore rehearsals required by issues #38 and #43.
2. Keep `MULTI_CIRCLE_CONTROL_PLANE_ENABLED`,
   `MULTI_CIRCLE_AVAILABILITY_ENABLED`,
   `SECONDARY_CIRCLE_COORDINATION_ENABLED`,
   `SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED`, and
   `SECONDARY_CIRCLE_SCHEDULING_ENABLED` false. Also disable the four
   credential consumers: `EMAIL_PASSWORD_ACTIVATION_ENABLED`,
   `PASSWORD_RESET_ENABLED`, `INVITATION_EMAIL_DELIVERY_ENABLED`, and
   `IDENTITY_MANAGEMENT_ENABLED`. If an existing credential consumer cannot be
   disabled, hold production promotion until Step 4 finishes.
3. Apply each pending managed migration in order: v13, then v14, then v15, each
   as a separate protected migration step. Before each immediately-next-version
   apply, complete a fresh protected
   backup/restore rehearsal, inspect status, and obtain the separate approval;
   after each apply, start again from a fresh rehearsal. Never batch or skip a
   version. Verify the v13 coordination tables, v14 creation artifacts, four
   uninitialized v15 control rows, unchanged pre-existing data, and the complete
   managed ledger through v15.
4. Inspect and adopt all four configured credential purposes through the
   protected key-control workflow before continuing to v16 or enabling any
   credential consumer. Toggle
   `CREDENTIAL_KEY_CONTROL_MUTATIONS_ENABLED` only for the one approved adopt
   operation and return it to false afterward. That variable authorizes control
   mutation; it does not disable or enable a credential consumer. Verify
   redacted accepted status for all four purposes.
5. From that accepted v15 state, complete a new protected backup/restore
   rehearsal and status inspection, separately approve and apply only v16, and
   verify the 16-row ledger, 52 tables, 56 indexes, empty schedule tables, and
   unchanged pre-v16 data. Deploy the v16-aware runtime with
   `SECONDARY_CIRCLE_SCHEDULING_ENABLED=false`; verify health and ordinary
   single-circle login, roster, invitation, and pairing, then restore each
   required credential consumer separately.
6. Enable the control-plane flag in staging. Create a fixture account with two active circle
   memberships and verify selection, cross-tab reload, scoped roster/invitation
   operations, last-owner rules, and the explicit pairing/workspace 409.
7. Keep `MULTI_CIRCLE_AVAILABILITY_ENABLED=false`, then enable it in staging.
   Verify opposite primary/secondary decisions, exact request/response context
   versions, secondary `cycle_default`, stale-switch and membership-removal
   zero-write behavior, and unchanged 409s on every other data-plane route.
8. Repeat the control-plane and availability checks in production before admitting a real
   secondary membership. Monitor only aggregate response/error counts; circle
   names, invitation targets, and session identifiers must not enter telemetry.
9. Canary `SECONDARY_CIRCLE_COORDINATION_ENABLED` as described in
   `SELECTED_CIRCLE_PAIRING.md`; Steps 3 and 5 applied its v13 schema and the
   complete v16 ledger required by current runtime readiness. Keep
   `SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED=false` until a separate sender and
   provider canary succeeds.
10. Keep `SECONDARY_CIRCLE_SCHEDULING_ENABLED=false` until coordination is
    healthy, then canary the schedule flows and dashboard-only calendar export
    exactly as described in `SECONDARY_SCHEDULING.md`.

Rollback is application-only. To roll back scheduling alone, disable
`SECONDARY_CIRCLE_SCHEDULING_ENABLED`. For a broader rollback, disable
`MULTI_CIRCLE_AVAILABILITY_ENABLED` to restore the legacy availability gate
without disabling roster/invitation selection; disable
`MULTI_CIRCLE_CONTROL_PLANE_ENABLED` only if the broader control plane must also
roll back. Context, cycle, decision, and schedule rows can remain; no membership
or tenant data is deleted.

## Deferred work

Circle archive and secondary workspace ownership remain separate increments.
Pairing weeks, participants, messages, runs, snapshots, video, AI, notification
idempotency, and associated foreign keys must gain canonical `circle_id`
ownership before their secondary-circle flags can be enabled. Secondary
schedule email remains a separate increment with its own payload and delivery
revalidation. Postgres with row-level security remains the preferred final
tenancy boundary; a Turso retrofit remains possible but requires table rebuilds
and application-enforced authorization.
