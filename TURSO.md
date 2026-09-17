# Turso operations

Randori Circle uses SQLite-compatible libSQL through `@libsql/client`. The repository does not use Drizzle and application requests never create or alter schema.

## Configuration

Create a Turso database and token, then configure the same values for the operator shell and the Vercel project:

```bash
turso db create randori-circle --location lhr
turso db show randori-circle --url
turso db tokens create randori-circle
```

Required database variables:

```text
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
```

Keep the token server-side. The browser must never connect to Turso directly.

## Versioned migrations

The canonical schema is in `db/schema.js`. Ordered, immutable migrations are in `db/migrations/`, and `schema_migrations` records each applied version and SHA-256 checksum.

Check status without modifying the database:

```bash
npm run db:status
```

Apply pending migrations:

```bash
npm run db:migrate
```

The runner applies one version per write transaction. It validates the complete ledger before writing, rejects gaps, checksum/name changes, and databases newer than the running application, and retries only bounded SQLite lock conflicts.

Migration 3 archives duplicate schedule rows before retaining a deterministic winner and adding the unique `(week_id, pair_group_id)` index. Migration 4 refuses to proceed when duplicate pairing-week labels need manual reconciliation.

## Safe production rollout

1. Create and verify a dated SQL backup (replace the database name as needed):

   ```bash
   backup_file="randori-circle-$(date +%Y%m%d-%H%M%S).sql"
   turso db shell randori-circle .dump > "$backup_file"
   test -s "$backup_file"
   ```

2. Restore that backup into a disposable clone and bind every command to that target explicitly:

   ```bash
   turso db create randori-circle-migration-check --location lhr
   turso db shell randori-circle-migration-check < "$backup_file"
   clone_db_url="$(turso db show randori-circle-migration-check --url)"
   clone_db_token="$(turso db tokens create randori-circle-migration-check)"
   TURSO_DATABASE_URL="$clone_db_url" TURSO_AUTH_TOKEN="$clone_db_token" npm run db:migrate
   TURSO_DATABASE_URL="$clone_db_url" TURSO_AUTH_TOKEN="$clone_db_token" npm run db:status
   ```

   Run the application test suite against the clone as appropriate. Keep clone credentials out of shell history, logs, and the repository.

3. Before migration 4, explicitly check production for pairing-week duplicates. `db:status` is read-only schema validation and does not perform this data preflight:

   ```bash
   turso db shell randori-circle "SELECT week_label, COUNT(*) AS copies FROM pairing_weeks GROUP BY week_label HAVING COUNT(*) > 1;"
   ```

   Reconcile any returned rows manually; do not delete pairing history automatically.
4. Resolve and verify the production target, then run status, migrate, and status again with explicit inline credentials. The first status command is expected to exit nonzero when migrations are pending:

   ```bash
   production_db_url="$(turso db show randori-circle --url)"
   production_db_token="$(turso db tokens create randori-circle)"
   node -e "console.log(new URL(process.argv[1]).hostname)" "$production_db_url"
   TURSO_DATABASE_URL="$production_db_url" TURSO_AUTH_TOKEN="$production_db_token" npm run db:status
   TURSO_DATABASE_URL="$production_db_url" TURSO_AUTH_TOKEN="$production_db_token" npm run db:migrate
   TURSO_DATABASE_URL="$production_db_url" TURSO_AUTH_TOKEN="$production_db_token" npm run db:status
   ```

5. Deploy the exact tested commit.
6. Confirm `GET /api/health` returns HTTP 200 and `status: "ready"`.

Migrations must precede deployment because Vercel preview/build jobs can run concurrently and may target the wrong database. Do not put production migration execution in a generic Vercel build command.

Schema migrations are forward-only. If an application rollback is necessary, restore the pre-migration backup only when the older application is not compatible with the new schema; otherwise roll the application back and leave additive migrations in place. To rehearse a restore without touching production:

```bash
turso db create randori-circle-restore-check
turso db shell randori-circle-restore-check < randori-circle-YYYYMMDD-HHMMSS.sql
turso db shell randori-circle-restore-check "PRAGMA integrity_check;"
```

Delete the temporary restore-check database only after verifying the backup and recording the result. A production restore requires a maintenance window, a paused deployment, and an explicit operator decision; never import a dump over a live database.

## Readiness

`GET /api/health` is read-only. It never creates, alters, repairs, seeds, or cleans database data.

It returns HTTP 200 only when:

- Turso is reachable;
- the ledger exactly matches this build's migration manifest;
- every required table, column, constraint, index, and migration artifact matches the canonical contract.

It returns HTTP 503 with one stable reason when the database is not ready:

- `database_unreachable`
- `schema_uninitialized`
- `schema_outdated`
- `schema_ahead`
- `schema_mismatch`
- `schema_drift`

Responses expose version/status metadata only, never raw database errors or credentials.

## Administrative init

`POST /api/init` remains an authenticated administrator adapter around the same migration runner. It reports the before/applied/after versions and then explicitly seeds the bundled question catalogue.

Use the CLI for a fresh database: database-backed admin authentication cannot work before `auth_accounts` exists.

## Local development

The npm scripts intentionally do not load `.env` implicitly. Use a separate local or development database and provide its target explicitly, for example:

```bash
npm ci
TURSO_DATABASE_URL=file:./randori-local.sqlite npm run db:migrate
TURSO_DATABASE_URL=file:./randori-local.sqlite npm run db:status
npm test
```

The unit suite uses isolated libSQL databases. Browser tests mock application APIs and do not access production.

## Related secrets

Database configuration is only part of the production environment. Also set independent `JWT_SECRET` and `CRON_SECRET` values, Google OAuth credentials, `APP_URL`, the private-beta allowlist, and notification provider secrets documented in `.env.example` and `GOOGLE_OAUTH.md`.
