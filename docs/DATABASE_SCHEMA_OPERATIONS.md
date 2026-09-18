# Database schema inspection

Randori now has a versioned, read-only schema inspection foundation. It does **not** migrate a database. Its purpose is to make the current state measurable before an apply/restore workflow is introduced.

## Contract

- `db/schema-manifest.js` is the current contract: 28 application tables and 26 named indexes.
- The manifest includes column/default/primary-key contracts, checks, foreign keys, unique constraints, AUTOINCREMENT/collation/table options, and unique, partial, descending, and expression-index semantics. SQLite-created `sqlite_autoindex_*` indexes are intentionally outside the named-index count.
- `ai_monthly_usage` is a retired table. Its presence is reported as tolerated legacy state; it is not treated as current schema and is never changed.
- Each plan owns a frozen ordered snapshot of its canonical table/index definitions. Both that operation snapshot and the surrounding plan metadata have pinned SHA-256 checksums, while the resolved current schema has a separate checksum. A reviewed schema change must append a plan containing the replacement definition; later definitions for the same artifact supersede earlier ones without rewriting their history.
- The plan metadata is descriptive and non-executable. No migration ledger is claimed and no schema version is inferred from table presence.

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
  "summary": {"expectedTables": 28, "expectedIndexes": 26, "blockers": 0},
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

Do not pipe `db:plan` into a database shell. The output is an inspection artifact for review, backup planning, and the future explicit migration runner.

## Runtime DDL debt

Several existing request paths still contain best-effort `CREATE` and `ALTER` statements. `npm run check:runtime-ddl` fingerprints the exact normalized statement set and occurrence counts per API module. CI fails when a statement is added, changed, assembled from string fragments, or removed without an intentional allowlist update.

This is a freeze, not an endorsement. Existing statements remain temporarily for compatibility. New schema work belongs in the forthcoming explicit migration runner; the allowlist should shrink as request-path DDL is removed.

## Operator sequence

1. Complete a backup and restore rehearsal.
2. Run `npm run --silent db:status` against the restored copy and retain its JSON output.
3. Run `npm run --silent db:plan` and review every blocker and proposed artifact.
4. Do not make production changes from this plan. The current slice has no apply command.
5. Continue using the authenticated `/api/init` membership rollout documented in `TURSO.md` until an explicit migration runner supersedes it.

Production migration remains blocked until real Turso credentials, a verified backup, and a restore rehearsal are available.
