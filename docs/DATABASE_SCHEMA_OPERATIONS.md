# Database schema operations

Randori has read-only schema inspection for configured databases, a transactional migration runner for local database files, and a protected Turso PITR rehearsal that mutates only a disposable restore. Production migration remains disabled until a real rehearsal has completed successfully.

## Contract

- `db/schema-manifest.js` is the current contract: 48 application tables and 52 named indexes.
- The manifest includes column/default/primary-key contracts, checks, foreign keys, unique constraints, AUTOINCREMENT/collation/table options, and unique, partial, descending, and expression-index semantics. SQLite-created `sqlite_autoindex_*` indexes are intentionally outside the named-index count.
- `ai_monthly_usage` is a retired table. Its presence is reported as tolerated legacy state; it is not treated as current schema and is never changed.
- `schema_migrations` is a runner-owned operational table. General schema inspection recognizes it without treating it as unexpected application drift; the migration runner validates its exact schema and rows separately.
- `/api/health/live` is a process-only liveness probe. `/api/health/ready` (and the backward-compatible `/api/health`) is a fresh, non-mutating deployment gate that requires the exact current manifest and immutable ledger, enforced foreign keys and checks, and a valid membership rollout. When `CIRCLE_MEMBERSHIP_ENABLED=true`, readiness also requires a completed closed rollout; pristine-open is accepted only while membership enforcement is disabled. Local readiness verifies the already-prepared database is a real existing file before opening its shared client. It returns only generic `no-store` 200/503 bodies and never runs migration or schema DDL.
- Each plan owns a frozen ordered snapshot of its canonical table/index definitions. Both that operation snapshot and the surrounding plan metadata have pinned SHA-256 checksums, while the resolved current schema has a separate checksum. A reviewed schema change must append a plan containing the replacement definition; later definitions for the same artifact supersede earlier ones without rewriting their history.
- `db:plan` remains descriptive and non-executable. The local runner uses separately checksummed executable migrations and records their exact version, name, checksum, timing, and disposition in `schema_migrations`.
- Migration v3 adds the canonical `pairing_cycles` and `pairing_cycle_availability` contracts. It is additive: v1 and v2 definitions and checksums remain unchanged. A cycle row binds the full UTC boundary/time-zone descriptor to a tenant scope, while availability rows use an optimistic integer version and an exact integer boolean. The legacy account boolean is not the durable source of truth for these tables.
- Migration v4 adds the provider-identity contract keyed by OpenID Connect issuer and subject, with a second uniqueness constraint allowing at most one identity from an issuer per account. Existing Google subjects remain in `auth_accounts.google_sub` for compatibility and are bound to the canonical issuer on their next verified sign-in.
- Migration v5 adds durable application sessions keyed only by a hashed random identifier, with fixed creation/expiry bounds, explicit revocation metadata, account cascading, and an account-scoped active-session lookup index. Runtime authentication probes this schema read-only and fails closed; it never creates session storage on a request path.
- Migration v6 adds the provider-neutral `outbox_events` and `outbox_audit_events` contracts plus dispatch, lease, and audit indexes. It is additive: earlier migration definitions and checksums remain immutable. Pairing email is the first event adapter; request paths never create or alter these tables. Before each drain, an idempotent DML-only compatibility bridge copies actionable rows from the legacy pairing queue using the exact historical provider idempotency key; terminal legacy rows are not redelivered.
- Migration v7 adds `auth_email_activations` and its token/email lookup indexes. It stores only hashed verification credentials and bounded resend state; verification email payloads use encrypted outbox envelopes. Account, invitation, membership, audit, activation, and session writes commit atomically.
- Migration v8 adds `auth_password_resets`, `auth_recent_proofs`, and their bounded lookup indexes. Reset rows contain only token/email hashes and lifecycle state; password replacement, reset consumption, and account-wide session revocation commit atomically. Recent-auth evidence is tied to one hashed live session.
- Migration v9 adds `auth_provider_email_state`, `auth_identity_audit_events`, and their account-scoped audit indexes. Provider email observations contain only a domain-separated HMAC, a bounded non-secret key version, and a one-way fingerprint that binds that version to one key, while lifecycle events use bounded event/provider/outcome/reason enums and never store a raw email, provider subject, OAuth credential, or session identifier. The existing v4 issuer/subject uniqueness constraints remain the credential-ownership authority. Hash-key rotation monotonically increments `IDENTITY_EMAIL_HASH_KEY_VERSION` and retains up to three ordered prior keys long enough to distinguish a same-email rekey from a genuine provider change. If a prior key is unavailable, the next observation is a neutral rebaseline and emits only `provider_email_rekeyed`. Readiness rejects version downgrade and same-version key substitution before changing an observation or appending an event.
- Migration v10 adds migration-owned room-cursor and sender-window chat indexes without changing message rows or API limits.
- Migration v11 adds disabled-by-default chat-retention control, explicit room ownership, durable bounded runs, legal holds, count-only audit, and a chronological expiry index. It does not seed an enabled control row or delete chat. See `CHAT_RETENTION.md` before any protected operation.
- Migration v12 adds session-bound active-circle context with a monotonically increasing compare-and-swap version and account/circle lookup indexes. Its composite session foreign key prevents binding one account to another account's session. Membership removal preserves the versioned context tombstone so reactivation cannot resurrect a stale generation; session removal cascades the context away. Request paths never create this table.
- Migration v13 adds immutable, circle-owned pairing publications, complete
  availability eligibility snapshots, and exact-scope groups for secondary
  coordination. Restrictive composite foreign keys keep every child on the
  publication's circle and cycle, bind the full publication descriptor to its
  availability cycle, and admit only available members assigned to one exact
  group slot. These rows never authorize a legacy room.

## Commands

Use database credentials only in an operator environment, never in browser code or committed files.

```bash
TURSO_DATABASE_URL=libsql://... \
TURSO_AUTH_TOKEN=... \
npm run --silent db:status

TURSO_DATABASE_URL=libsql://... \
TURSO_AUTH_TOKEN=... \
npm run --silent db:plan
```

Both commands execute only `SELECT` and `PRAGMA` statements. A guard rejects a non-read-only statement before it reaches the client.

`db:status` returns one JSON document. Exit code `0` means the known tables, columns, and named-index semantics match. Exit code `2` means inspection completed and found blockers. Exit code `1` means configuration or inspection failed.

`db:plan` also returns one JSON document, but exits `0` after a successful inspection even when drift exists. Its `executable` field is always `false`. Missing tables and indexes include the target DDL for review; column changes and incompatible definitions are explicitly marked as blocked manual work. Nothing is applied.

Representative output fields:

```json
{
  "readOnly": true,
  "manifest": {"version": 1, "checksum": "..."},
  "foreignKeysEnabled": true,
  "checkConstraintsEnabled": true,
  "summary": {"expectedTables": 48, "expectedIndexes": 52, "blockers": 0},
  "drift": {
    "missingTables": [],
    "missingColumns": [],
    "unexpectedColumns": [],
    "columnDrift": [],
    "constraintDrift": [],
    "missingIndexes": [],
    "indexDrift": []
  },
  "tolerated": {"legacyTables": ["ai_monthly_usage"]}
}
```

Do not pipe `db:plan` into a database shell. Its output is an inspection artifact only; the local migration runner executes its own immutable, checksummed operations.

## Local migration rehearsal

The migration runner never reads `TURSO_DATABASE_URL` or `TURSO_AUTH_TOKEN`. It requires an explicit, absolute `file:` URL and rejects remote URLs, relative paths, in-memory targets, URL query parameters, directories, special files, and final-component symbolic links. Parent aliases such as macOS `/tmp` are resolved to their canonical directory before the database is opened.

First inspect the target and retain its `stateFingerprint`:

```bash
npm run --silent db:migrate -- \
  status --database file:///absolute/path/to/restored-randori.db
```

Then pass that exact fingerprint to one mutation command:

```bash
npm run --silent db:migrate -- \
  apply --database file:///absolute/path/to/restored-randori.db \
  --expected-state <stateFingerprint>

npm run --silent db:migrate -- \
  adopt --database file:///absolute/path/to/restored-randori.db \
  --expected-state <stateFingerprint>
```

When a restored production copy has an exact historical schema but no ledger,
inspect and adopt only that known migration prefix before applying the remaining
migrations. For example, an exact unmanaged v2 copy can be rehearsed with:

```bash
npm run --silent db:migrate -- \
  status --database file:///absolute/path/to/restored-randori.db \
  --through-version 2

npm run --silent db:migrate -- \
  adopt --database file:///absolute/path/to/restored-randori.db \
  --expected-state <v2StateFingerprint> --through-version 2

# Inspect again without a prefix. The result must be managed at v2 with v3,
# v3 through v13 pending before using its new full-set fingerprint for the upgrade.
npm run --silent db:migrate -- \
  status --database file:///absolute/path/to/restored-randori.db

npm run --silent db:migrate -- \
  apply --database file:///absolute/path/to/restored-randori.db \
  --expected-state <managedV2StateFingerprint>
```

`--through-version` accepts an integer from `1` through the repository's latest
executable migration and is valid only for `status` and `adopt`. `apply` always
targets the complete executable migration set and rejects this option, so an
operator cannot accidentally leave a managed database on a requested partial
install. Every successful or controlled-refusal result includes both
`throughVersion` (the exact set inspected or adopted) and `latestVersion` (the
repository maximum). The selected migration set is part of the state
fingerprint, so a full-set fingerprint cannot authorize a prefix adoption, or
vice versa. Within a status result, `ledger.latestVersion` remains the selected
target (`throughVersion`); use the top-level `latestVersion` to see whether the
repository contains newer migrations.

`status` is read-only, including for a missing target: it reports a fresh-state fingerprint without creating the file. `apply` accepts only fresh databases or valid managed databases and applies each pending version transactionally with its ledger row. `adopt` accepts only a fully compatible unmanaged database and writes only the ledger; it never repairs or changes application schema or data.

The runner reports three states:

| State | Meaning | Allowed next action |
| --- | --- | --- |
| `fresh` | No application schema and no ledger. | `apply` |
| `managed` | A ledger exists and its contiguous history matches the executable migrations. | `apply`, including a latest-version no-op, only while its recorded schema is exact |
| `unmanaged` | Application objects exist without a valid ledger history. | `adopt` only when the complete schema and membership invariants are exact |

The fingerprint binds the inspected schema, ledger, and membership rollout evidence. Both mutation modes recompute it inside their write transaction before making changes. A stale fingerprint is refused without a write; run `status` again and investigate the change rather than copying a new value blindly.

For an unmanaged database, adoption requires the exact current schema. The membership rollout must contain exactly the singleton row with ID `1`. An open latch may not contain circles, memberships, invitations, or audit state. A closed latch must have exactly one active primary circle, an active owner, exact owner-authored backfill completion evidence, canonical backfill or accepted-invitation provenance for every non-demo account, no uncovered accounts, and no orphan active memberships. The runner preserves the latch; it never reopens registration.

Every invocation emits exactly one redacted JSON document. Successful results and controlled refusals use stdout; invocation or operational failures use stderr.

| Exit | Meaning |
| --- | --- |
| `0` | Status is actionable, or apply/adopt completed safely (including a no-op). |
| `2` | A state or safety precondition refused the current step. A previous migration version may already have committed; run `status` again. |
| `1` | Usage, target validation, I/O, or migration execution failed. |

Output includes only the target kind and whether it existed before opening. It never includes the file path, SQL, credentials, or raw provider errors.

## Protected Turso PITR rehearsal

The manually dispatched `turso-backup-restore-rehearsal.yml` workflow is the remote counterpart to the local migration rehearsal. It runs only on the latest default-branch commit and obtains credentials from the protected `turso-migration-rehearsal` environment. It does not expose a general remote migration command.

The workflow verifies the configured production name, immutable `DbId`, group, explicit base-database status, and protected expected `block_writes` value before any mutation. It writes a private journal before changing configuration, confirms a write block before choosing the PITR timestamp, and restores the original state immediately after PITR creation. Signal handling and a separately invoked `always()` cleanup command provide bounded fallback recovery. Its source connection is additionally restricted by a read-only, database-scoped token and a statement guard. The migration runner receives only the disposable restore connection.

The restore must have a new exact `DbId` and an exact parent binding to the production ID, name, and requested `branched_at` instant. Before migration, authenticated evidence must match at the same exact managed or unmanaged migration prefix. Unmanaged history is adopted only on the restore; the restore is then advanced to the repository latest version. A second evidence pass proves every pre-existing table digest/count and SQLite sequence digest remains unchanged and every newly added table has the canonical seeded row count.

Cleanup re-fetches and verifies the exact restored identity immediately before deletion. An ambiguous create or identity change is never resolved by blind name deletion. Turso's delete endpoint is name-only and has no conditional-ID precondition, so the run requires exclusive database administration and cannot eliminate an out-of-band delete/recreate race. Exact recovery data is atomically written under `$RUNNER_TEMP/private-recovery` with mode `0600`, consumed by the separate cleanup process, and excluded from artifact uploads. Protected environment identity variables and the deterministic run/attempt restore name remain available if the runner is lost. The successful public artifact is a domain-separated HMAC attestation with exact GitHub run, repository code, evidence, migration, RPO/RTO, and cleanup bindings; it is uploaded only after the independent cleanup step succeeds. Its verifier requires trusted run-success context and recomputes the protected source and backup-reference digests, while every uploaded artifact excludes database names/IDs, URLs, tokens, SQL, row values, and raw provider errors.

See [Turso backup/restore rehearsal](TURSO_BACKUP_RESTORE_REHEARSAL.md) for environment setup, execution, artifact interpretation, and recovery steps.

## Protected Turso production migration

The manual `turso-production-migration.yml` workflow consumes only a successful, signed rehearsal artifact from the exact current `main` commit. It independently retrieves and verifies the GitHub run and artifact, rechecks the exact base-database identity and protected provider state before minting a short-lived database token, and then exposes `status`, `adopt`, or `apply` through the same transactional migration engine.

Status is read-only. Adopt and apply require both the protected enable variable and the exact state fingerprint returned by a preceding status. Apply refuses more than one pending version, and ambiguous commit failures are never retried. The workflow is serialized with the PITR rehearsal, writes only a redacted audit artifact, and is disabled for mutations by default.

See [Protected Turso production migration](TURSO_PRODUCTION_MIGRATION.md) for environment setup, the historical-prefix adoption/current-version apply sequence, failure handling, and rollback boundaries.

## Runtime DDL debt

Several existing request paths still contain best-effort `CREATE` and `ALTER` statements. `npm run check:runtime-ddl` fingerprints the exact normalized statement set and occurrence counts per API module. CI fails when a statement is added, changed, assembled from string fragments, or removed without an intentional allowlist update.

This is a freeze, not an endorsement. Existing statements remain temporarily for compatibility. New schema work belongs in appended, checksummed executable migrations; the allowlist should shrink as request-path DDL is removed.

## Operator sequence

1. Rehearse locally first. Never point `db:migrate` at a remote URL.
2. Run local `db:migrate status` and retain its JSON result and fingerprint. For a known historical unmanaged schema, use the reviewed `--through-version` value.
3. Run local `db:migrate apply` for a fresh or managed file, or `db:migrate adopt` only for an exact unmanaged file. A prefix may be adopted, but never partially applied.
4. Run local `db:migrate status` again, then run the existing `db:status` and `db:plan` inspections against the same rehearsal database.
5. Configure the protected GitHub environment and execute the manual PITR workflow from current `main`. Retain its sanitized successful artifact in issue #38.
6. If any rehearsal fails, do not edit `schema_migrations` or delete a database by name. Follow the exact recovery steps in the PITR runbook.
7. Configure the protected migration environment with mutation disabled. Run the exact `status → adopt (if unmanaged) → status → apply → status` sequence in the production migration runbook only after a same-commit real rehearsal succeeds.

Production mutation remains blocked by `TURSO_PRODUCTION_MIGRATIONS_ENABLED=false` until real Turso credentials and a successful protected PITR rehearsal are available. Mocked CI tests do not satisfy that operational gate.
