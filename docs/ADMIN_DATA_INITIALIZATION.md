# Admin data initialization

Issue: [#171](https://github.com/festus14/randori-circle/issues/171)
Parent: [#44](https://github.com/festus14/randori-circle/issues/44)
Decision: [ID-39](IMPLEMENTED_DECISIONS.md#id-39-make-admin-initialization-data-only-and-atomic)

## Boundary

`POST /api/init` is a one-time data cutover, not a schema migration. Before any
write, it verifies the exact current schema, the complete immutable migration
ledger, the migration-seeded credential controls, and a pristine-open or valid
completed membership rollout. The probe uses only `SELECT` and `PRAGMA` inside
the same transaction as the cutover.

The transaction then revalidates the caller's live durable session and current
non-demo global-administrator status. A database `is_admin` flag or an exact
normalized `ADMIN_EMAILS` match grants authority; JWT claims alone do not.

On the first valid call the transaction writes only:

- one primary `circles` row;
- one active `circle_memberships` row for each current non-demo account;
- one deterministic `membership.backfilled` audit per included account;
- one `membership.backfill.completed` audit; and
- the existing `circle_membership_rollout` singleton from open to closed.

The caller, database administrators, and configured administrator emails become
owners. Other non-demo accounts become members. Demo accounts and legacy
`users` rows are never imported. The registration latch is closed last, a
completed-rollout postcondition is checked, and then the transaction commits.

A repeated call against a valid completed rollout is read-only and returns the
same primary-circle ID with `changed:false`. A registration racing the cutover
is serialized by the existing transaction-bound signup latch: it is included
before the cutover commits or rejected after the latch closes.

## Schema ownership

No migration is added by this change. Migration v1 already owns every legacy
table, column, schedule uniqueness constraint, and non-membership index formerly
created by `/api/init`. Migration v2 owns the circle tables, rollout singleton,
Google-subject index, and circle indexes. Migrations v3 through v16 remain part
of the exact current readiness requirement.

The removed schedule cleanup kept only the greatest row ID for each
`(week_id,pair_group_id)`. It is not moved to a request or a new migration: a
managed current database already enforces that uniqueness, so duplicates imply
schema drift. An unmanaged database with duplicates is ineligible for adoption.
Inspect and reconcile such data on a verified restore through a separately
reviewed remediation; never choose a survivor automatically in production.

## Responses

- Invalid method: `405 {"error":"POST only"}`.
- Missing or invalid signed credential: `401`.
- Revoked session: `401`.
- Non-admin or demo account: `403`.
- Missing, stale, drifted, or operationally unavailable database: generic
  `503 {"error":"data unavailable"}` without schema or provider details.
- Success: `200` with `ok`, a stable message, `circle_id`, and `changed`.

Ordinary route response shapes are unchanged.

## Rollout and recovery

1. Keep `CIRCLE_MEMBERSHIP_ENABLED=false`.
2. Complete the protected backup/restore rehearsal and migration workflow.
3. Require readiness at the exact application migration version; `/api/init`
   cannot make an old database current.
4. Sign in as the bootstrap non-demo administrator and call `POST /api/init`.
5. Verify one active primary circle, at least one active owner, complete audited
   account coverage, and `registrations_closed=1`.
6. Enable membership enforcement only after those checks pass.

If a pre-commit step fails, all initialization writes roll back. If commit
delivery is ambiguous, inspect readiness and repeat the same request; the valid
completed state is a read-only no-op. Do not reopen the registration latch as an
automatic rollback. Restore the verified backup when the committed data itself
must be reversed.

## Verification

```sh
npm run check:runtime-ddl
npm run check:syntax
npm run test:migrations
npm run test:coverage
npm run test:e2e
```

The focused tests additionally prove exact-schema failure without mutation,
live administrator revalidation, no runtime DDL, repeat no-op behavior, and
full rollback after an injected mid-cutover failure.
