# Operations request-path DDL retirement

Issue: [#174](https://github.com/festus14/randori-circle/issues/174)

Parent: [#44](https://github.com/festus14/randori-circle/issues/44)

Decision: [ID-42](IMPLEMENTED_DECISIONS.md#id-42-forbid-runtime-ddl-and-make-admin-operations-readiness-route-scoped)

## Boundary

Migration v1 owns every legacy account and pairing object used by administrator
promotion and demo operations. These HTTP handlers no longer create tables,
add columns, or install indexes. This removes the final 16 runtime DDL
signatures and makes the repository allowlist empty. New schema belongs only in
an appended, checksummed executable migration.

The removed compatibility bootstrap contained seven table definitions, two
indexes, and seven column alterations. `users`, `pairing_email_outbox`, its
pending index, `auth_accounts.availability_updated_at`, and
`auth_accounts.phone` were not used by any of these operations. The remaining
objects were provisioned for every administrator request even when only one
route needed them. The canonical v1 definitions already include all seven
altered columns, so no new migration is required.

## Read-only contracts

`api/_ops-readiness.js` keeps a separate contract for each operation:

| Contract | Migration-owned data |
| --- | --- |
| Promotion | `auth_accounts.id`, `email`, and `is_admin` |
| Demo seed | Account identity, password, display, availability, administrator, and demo columns; primary key on `id`; unique `email` |
| Demo shuffle | Demo-seed account contract plus the exact week, group, run, and participant projections used to read and persist a demo pairing |
| Demo reset | Demo account/week markers and the `week_id` references deleted from groups, runs, and participants |

Shuffle metadata checks additionally prove the
`pairing_week_runs(week_label)` and
`pairing_participants(week_id,user_id)` primary keys and the canonical unique
`idx_pairing_weeks_week_label` index. These constraints protect the existing
publication claim, participant uniqueness, and one-row-per-week behavior.

The probes use only `SELECT` and table-valued `PRAGMA` reads. Concurrent calls
for one concrete database client and contract share an in-flight promise. A
successful result is cached; a rejection is evicted for a later retry. Contracts
and clients remain isolated.

## Authorization and side-effect order

Every operation now follows this order:

1. Reject an invalid origin or method.
2. Verify the durable session.
3. Read the current account row and authorize its database flag or exact
   normalized `ADMIN_EMAILS` membership.
4. Reject malformed promotion input.
5. Prove only the selected handler's read-only schema contract.
6. Persist the existing configured-administrator flag synchronization, when
   needed.
7. Perform the requested business reads and writes.

An unauthenticated caller receives the existing `401`. A live non-admin
receives the existing `403` after one authorization read and performs no
readiness probe, DDL, or DML. Authentication-database or readiness failure
returns `503 {"error":"admin operation unavailable"}` without exposing schema
details or performing a write. Healthy validation and success response shapes
remain unchanged.

Demo semantics remain unchanged: seed creates designated demo accounts;
shuffle uses all available demo and real accounts and marks the week as demo
when any demo account participates; reset removes demo weeks and their pairing
rows plus demo accounts while retaining real accounts.

## Verification and rollout

Run:

```sh
npm run check:runtime-ddl
npm run check:syntax
npm run test:migrations
npm run test:coverage
npm run test:e2e
```

Focused tests pin every projection and conflict target, per-client and
per-contract caching, failure retry, authorization-before-readiness ordering,
no-side-effect failures, response compatibility, and all four operations on a
real fully migrated SQLite database.

Production must be on the reviewed migration through v16 before this code is
promoted. This increment performs no migration or provider mutation. A failed
probe requires inspection and roll-forward through the protected migration
workflow. Application rollback requires no database rollback, but it
reintroduces request-path schema mutation and is reserved for emergency
compatibility.
