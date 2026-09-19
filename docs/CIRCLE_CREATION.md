# Secondary-circle creation

This increment makes the selected-circle control plane reachable without seed
data. It is disabled unless both `CIRCLE_MEMBERSHIP_ENABLED=true` and
`MULTI_CIRCLE_CONTROL_PLANE_ENABLED=true`. Migration v14 owns its storage; this
release additionally requires exact managed readiness through v16 and the
central v15 credential-control adoption sequence before runtime promotion.

## Public contract

`POST /api/circles` is authenticated, same-origin, has no query parameters, and
accepts exactly:

```json
{"name":"Saturday practice","request_id":"an-opaque-client-generated-token"}
```

The name must already be trimmed and NFC-normalized, contain no control
characters, and fit both 80 Unicode code points and 240 UTF-8 bytes. The
request ID is a 16-128 character base64url token. It is only an idempotency key:
it is never a circle identifier or authorization input. The response projects
only the server-generated public circle identity, exact name, owner role,
non-primary marker, and context generation. Internal IDs, slug, receipt, audit,
session, limits, and digests never leave the server.

## Atomicity and retry safety

Migration v14 adds `circle_creation_requests`. Its primary key isolates the
request digest by account. Each receipt binds the exact name fingerprint,
initiating session hash, resulting circle, creation audit, and selected-context
generation. Composite restrictive foreign keys bind the receipt to the
creator's membership and the audit's circle. The session hash is deliberately
not a foreign key: receipt evidence must survive normal session pruning.

Every attempt opens one write transaction and rechecks database time, the exact
unrevoked session/account, a maximum of 10 active circles owned by the account,
and the existing 100-active-membership read ceiling. Receipt replay happens
before either cap. A matching replay returns the original result without
selecting again, incrementing context, or writing another audit. A changed
name/session or a context moved after the original result returns a fixed
conflict and never creates another circle.

A new result writes one `is_primary=0` circle with random public ID and random
non-name-derived slug, one active owner membership, one `circle.created` audit,
one receipt, and the exact initiating session's monotonic context generation.
No global rollout value, pairing cycle, availability decision, publication,
notification, or legacy workspace row is created. Availability retains its
existing lazy `cycle_default` materialization.

Known pre-commit lock conflicts retry with bounded backoff and repeat every
authorization, cap, receipt, and context check. Only exact receipt/audit/public
identity uniqueness races are retry candidates. Once commit begins, any error
is treated as ambiguous and is never retried internally. The client is told to
retry the same request ID; if the first commit applied, the durable receipt
returns its one result.

## Browser behavior

The create form remains visible for the normal sole-primary owner. One request
ID is generated per logical submission and retained after transport or
ambiguous failures. Before sending, the browser clears private circle and
workspace state, aborts older work, and fences the response by authentication
epoch, account, prior context generation, and control-plane epoch. Identity,
selection, or cross-tab changes abort/obsolete the request. A valid success is
broadcast as only account plus generation and followed by a canonical reload.

The selected new circle immediately shows its creator-only roster, empty
invitation list, lazy default availability, and unpublished coordination state.
It initially receives no schedule because no current pairing exists. After a
two-person pairing is published, the separate scheduling flag may expose only
dashboard coordination. Circle creation itself creates no schedule, room,
chat, video, execution, recap, AI, notification, or other legacy workspace
capability.

## Rollout and rollback

1. Use Steps 2–5 of the central protected v13-then-v14-then-v15, credential
   adoption, then v16 sequence in
   [Active circle context](ACTIVE_CIRCLE_CONTEXT.md#rollout) as the sole
   migration and credential-adoption authority. It uses a fresh backup/restore
   rehearsal and one separately approved, immediately-next-version apply for
   v13 through v15, protected adoption of all four configured credential
   purposes, and a new rehearsal plus separate v16 apply before runtime
   promotion; do not reapply any version from this runbook.
2. With that sequence complete and `MULTI_CIRCLE_CONTROL_PLANE_ENABLED=false`,
   verify the v14 creation artifacts, exact runtime readiness through v16, all
   four accepted credential controls, and unchanged pre-existing application
   data.
3. Enable the control plane in staging and test create/replay, cap, concurrent
   duplicate/distinct requests, revocation, cross-tab switching, and 320px UI.
4. Confirm new circles contain exactly one owner and no legacy workspace data.
5. Canary in production and monitor aggregate created/replayed/conflict/error
   counts only. Do not log names, request IDs, session hashes, or digests.

Rollback is application-only: disable `MULTI_CIRCLE_CONTROL_PLANE_ENABLED`.
Preserve receipts, circles, memberships, audits, and context generations. Do
not downgrade the schema, delete tenant records, or copy secondary state into
legacy tables.

## Alternatives considered

- Admin/SQL seeding is operationally simple but does not produce a usable flow.
- Client-provided IDs/slugs weaken ownership and collision boundaries.
- Create without selecting introduces an avoidable stale-context UI race.
- Audit dedupe alone cannot bind the exact name, session, and returned context.
- Eager availability/pairing defaults conflict with the existing lazy cycle
  contract and would create unnecessary data.
- Full secondary workspace creation remains deferred until every workspace
  table and authorization edge is canonically circle-owned.
