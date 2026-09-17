import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  runMigrations,
} from '../../db/migrate.js';
import { checkDatabaseReadiness, checkReadiness } from '../../db/readiness.js';

const fastRetry = Object.freeze({ maxAttempts: 6, baseDelayMs: 0, maxDelayMs: 0 });

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'randori-readiness-'));
  const db = createClient({ url: `file:${join(directory, 'test.sqlite')}` });
  let clientClosed = false;
  return {
    db,
    closeClient() {
      if (clientClosed) return;
      db.close();
      clientClosed = true;
    },
    close() {
      this.closeClient();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('a fully migrated database is ready', async () => {
  const fixture = temporaryDatabase();
  try {
    await runMigrations(fixture.db, fastRetry);
    const result = await checkDatabaseReadiness(fixture.db);
    assert.deepEqual(result, {
      ready: true,
      status: 'ready',
      reason: null,
      currentVersion: LATEST_SCHEMA_VERSION,
      latestVersion: LATEST_SCHEMA_VERSION,
      pendingVersions: [],
      missingTables: [],
      missingIndexes: [],
      missingColumns: [],
      columnDrift: [],
      missingUniqueConstraints: [],
      foreignKeyDrift: [],
      foreignKeysEnabled: true,
      indexDrift: [],
      missingMigrationArtifacts: [],
      issues: [],
    });
  } finally {
    fixture.close();
  }
});

test('an outdated database reports the precise pending migration versions', async () => {
  const fixture = temporaryDatabase();
  try {
    await runMigrations(fixture.db, {
      ...fastRetry,
      migrations: MIGRATIONS.slice(0, 2),
    });
    const result = await checkReadiness(fixture.db);
    assert.equal(result.ready, false);
    assert.equal(result.status, 'migration_required');
    assert.equal(result.reason, 'schema_outdated');
    assert.equal(result.currentVersion, 2);
    assert.equal(result.latestVersion, LATEST_SCHEMA_VERSION);
    assert.deepEqual(result.pendingVersions, [3, 4]);
    assert.equal(result.issues[0].code, 'schema_outdated');
  } finally {
    fixture.close();
  }
});

test('an uninitialized database is detected without creating a ledger', async () => {
  const fixture = temporaryDatabase();
  try {
    const result = await checkDatabaseReadiness(fixture.db);
    assert.equal(result.ready, false);
    assert.equal(result.status, 'migration_required');
    assert.equal(result.reason, 'schema_uninitialized');
    assert.equal(result.currentVersion, 0);
    assert.deepEqual(result.pendingVersions, [1, 2, 3, 4]);
    assert.equal(result.issues[0].code, 'schema_uninitialized');

    const ledger = await fixture.db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    );
    assert.equal(ledger.rows.length, 0, 'readiness must not initialize the database');
  } finally {
    fixture.close();
  }
});

test('physical schema drift is reported even when the ledger is current', async () => {
  const fixture = temporaryDatabase();
  try {
    await runMigrations(fixture.db, fastRetry);
    await fixture.db.execute('DROP INDEX idx_logs_created');
    const result = await checkDatabaseReadiness(fixture.db);
    assert.equal(result.ready, false);
    assert.equal(result.status, 'schema_invalid');
    assert.equal(result.reason, 'schema_drift');
    assert.equal(result.currentVersion, LATEST_SCHEMA_VERSION);
    assert.deepEqual(result.missingIndexes, ['idx_logs_created']);
    assert.equal(result.issues[0].code, 'schema_drift');
  } finally {
    fixture.close();
  }
});

test('same-name indexes with the wrong uniqueness, column order, or direction are drift', async () => {
  const fixture = temporaryDatabase();
  try {
    await runMigrations(fixture.db, fastRetry);

    await fixture.db.execute('DROP INDEX uq_pair_schedules_week_pair');
    await fixture.db.execute(
      'CREATE INDEX uq_pair_schedules_week_pair ON pair_schedules(week_id,pair_group_id)',
    );
    await fixture.db.execute('DROP INDEX idx_runs_user');
    await fixture.db.execute(
      'CREATE INDEX idx_runs_user ON session_runs(created_at ASC,user_id)',
    );

    const result = await checkDatabaseReadiness(fixture.db);
    assert.equal(result.ready, false);
    assert.equal(result.status, 'schema_invalid');
    assert.equal(result.reason, 'schema_drift');
    assert.deepEqual(result.missingIndexes, [
      'idx_runs_user',
      'uq_pair_schedules_week_pair',
    ]);
    assert.deepEqual(result.indexDrift.map(item => item.index), [
      'idx_runs_user',
      'uq_pair_schedules_week_pair',
    ]);
  } finally {
    fixture.close();
  }
});

test('column types, required nullability, primary keys, and stable defaults are enforced', async () => {
  const fixture = temporaryDatabase();
  try {
    await runMigrations(fixture.db, fastRetry);
    await fixture.db.execute('DROP TABLE auth_rate_limits');
    await fixture.db.execute(`CREATE TABLE auth_rate_limits (
      key INTEGER,
      attempts INTEGER DEFAULT 7,
      expires_at INTEGER
    )`);

    const result = await checkDatabaseReadiness(fixture.db);
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'schema_drift');
    assert.deepEqual(result.columnDrift, [
      {
        table: 'auth_rate_limits',
        column: 'key',
        mismatches: [
          { property: 'type', expected: 'TEXT', actual: 'INTEGER' },
          { property: 'primaryKeyPosition', expected: 1, actual: 0 },
        ],
      },
      {
        table: 'auth_rate_limits',
        column: 'attempts',
        mismatches: [
          { property: 'notNull', expected: true, actual: false },
          { property: 'defaultValue', expected: '0', actual: '7' },
        ],
      },
      {
        table: 'auth_rate_limits',
        column: 'expires_at',
        mismatches: [
          { property: 'notNull', expected: true, actual: false },
        ],
      },
    ]);
    assert.deepEqual(result.issues[0].details.columnDrift, result.columnDrift);
  } finally {
    fixture.close();
  }
});

test('auth, outbox, and workspace auto-unique constraints fail closed when absent', async () => {
  const fixture = temporaryDatabase();
  try {
    await runMigrations(fixture.db, fastRetry);
    await fixture.db.execute('DROP TABLE auth_accounts');
    await fixture.db.execute(`CREATE TABLE auth_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT,
      is_available INTEGER DEFAULT 1,
      availability_updated_at TEXT,
      is_admin INTEGER DEFAULT 0,
      is_demo INTEGER DEFAULT 0,
      bio TEXT,
      tz TEXT,
      interview_focus TEXT DEFAULT 'both',
      leetcode_handle TEXT,
      phone TEXT,
      google_sub TEXT
    )`);
    await fixture.db.execute('DROP TABLE pairing_email_outbox');
    await fixture.db.execute(`CREATE TABLE pairing_email_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      sent_at TEXT,
      provider_message_id TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    await fixture.db.execute('DROP TABLE pair_room_snapshots');
    await fixture.db.execute(`CREATE TABLE pair_room_snapshots (
      room_id TEXT PRIMARY KEY,
      week_id INTEGER NOT NULL,
      pair_group_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      client_seq INTEGER NOT NULL,
      language TEXT NOT NULL,
      question_id TEXT NOT NULL,
      code TEXT NOT NULL,
      updated_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    const result = await checkDatabaseReadiness(fixture.db);
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'schema_drift');
    assert.deepEqual(result.columnDrift, []);
    assert.deepEqual(result.missingUniqueConstraints, [
      { table: 'auth_accounts', columns: ['email'] },
      { table: 'pairing_email_outbox', columns: ['week_id', 'user_id', 'kind'] },
      { table: 'pair_room_snapshots', columns: ['week_id', 'pair_group_id'] },
    ]);
  } finally {
    fixture.close();
  }
});

test('an auth_accounts table with the right names but no constraints is drift', async () => {
  const fixture = temporaryDatabase();
  try {
    await runMigrations(fixture.db, fastRetry);
    await fixture.db.execute('DROP TABLE auth_accounts');
    await fixture.db.execute(`CREATE TABLE auth_accounts (
      id INTEGER,
      email TEXT,
      password_hash TEXT,
      display_name TEXT,
      color TEXT,
      created_at TEXT,
      last_login TEXT,
      is_available INTEGER,
      availability_updated_at TEXT,
      is_admin INTEGER,
      is_demo INTEGER,
      bio TEXT,
      tz TEXT,
      interview_focus TEXT,
      leetcode_handle TEXT,
      phone TEXT,
      google_sub TEXT
    )`);

    const result = await checkDatabaseReadiness(fixture.db);
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'schema_drift');
    assert.deepEqual(
      result.columnDrift.find(item => item.column === 'id')?.mismatches,
      [{ property: 'primaryKeyPosition', expected: 1, actual: 0 }],
    );
    assert.deepEqual(
      result.columnDrift.find(item => item.column === 'email')?.mismatches,
      [{ property: 'notNull', expected: true, actual: false }],
    );
    assert.ok(result.columnDrift.some(item =>
      item.column === 'created_at' &&
      item.mismatches.some(mismatch => mismatch.property === 'defaultValue')));
    assert.ok(result.missingUniqueConstraints.some(constraint =>
      constraint.table === 'auth_accounts' && constraint.columns.join(',') === 'email'));
  } finally {
    fixture.close();
  }
});

test('AI feedback and workspace foreign-key actions are enforced', async () => {
  const fixture = temporaryDatabase();
  try {
    await runMigrations(fixture.db, fastRetry);
    await fixture.db.execute('DROP TABLE ai_feedback');
    await fixture.db.execute(`CREATE TABLE ai_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT DEFAULT 'both',
      feedback_json TEXT NOT NULL,
      evidence TEXT,
      model_used TEXT,
      reason_for_pick TEXT,
      estimated_cost_cents INTEGER,
      confidence REAL DEFAULT 0.85,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    await fixture.db.execute('DROP TABLE pair_room_snapshots');
    await fixture.db.execute(`CREATE TABLE pair_room_snapshots (
      room_id TEXT PRIMARY KEY,
      week_id INTEGER NOT NULL,
      pair_group_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      client_seq INTEGER NOT NULL,
      language TEXT NOT NULL,
      question_id TEXT NOT NULL,
      code TEXT NOT NULL,
      updated_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (week_id, pair_group_id)
    )`);

    const result = await checkDatabaseReadiness(fixture.db);
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'schema_drift');
    assert.deepEqual(result.foreignKeyDrift.map(item => ({
      table: item.expected.table,
      fromColumns: [...item.expected.fromColumns],
      referencedTable: item.expected.referencedTable,
      onDelete: item.expected.onDelete,
      actual: item.actual,
    })), [
      {
        table: 'ai_feedback',
        fromColumns: ['session_id'],
        referencedTable: 'ai_sessions',
        onDelete: 'CASCADE',
        actual: [],
      },
      {
        table: 'pair_room_snapshots',
        fromColumns: ['pair_group_id'],
        referencedTable: 'pairing_groups',
        onDelete: 'CASCADE',
        actual: [],
      },
    ]);
    assert.deepEqual(result.issues[0].details.foreignKeyDrift, result.foreignKeyDrift);
  } finally {
    fixture.close();
  }
});

test('foreign-key enforcement must be enabled on the active connection', async () => {
  const fixture = temporaryDatabase();
  try {
    await runMigrations(fixture.db, fastRetry);
    await fixture.db.execute('PRAGMA foreign_keys=OFF');
    const result = await checkDatabaseReadiness(fixture.db);
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'schema_drift');
    assert.equal(result.foreignKeysEnabled, false);
    assert.equal(result.issues[0].details.foreignKeysEnabled, false);
  } finally {
    fixture.close();
  }
});

test('the migration ledger and duplicate archive require their full contracts', async () => {
  const ledgerFixture = temporaryDatabase();
  try {
    await runMigrations(ledgerFixture.db, fastRetry);
    const rows = await ledgerFixture.db.execute(
      'SELECT version,name,checksum,applied_at,execution_ms FROM schema_migrations ORDER BY version',
    );
    await ledgerFixture.db.execute('DROP TABLE schema_migrations');
    await ledgerFixture.db.execute(`CREATE TABLE schema_migrations (
      version TEXT,
      name TEXT,
      checksum TEXT,
      applied_at TEXT,
      execution_ms TEXT
    )`);
    for (const row of rows.rows) {
      await ledgerFixture.db.execute({
        sql: `INSERT INTO schema_migrations
          (version,name,checksum,applied_at,execution_ms) VALUES (?,?,?,?,?)`,
        args: [row.version,row.name,row.checksum,row.applied_at,row.execution_ms],
      });
    }
    const result = await checkDatabaseReadiness(ledgerFixture.db);
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'schema_mismatch');
    assert.ok(result.issues[0].details.columnDrift.length > 0);
  } finally {
    ledgerFixture.close();
  }

  const archiveFixture = temporaryDatabase();
  try {
    await runMigrations(archiveFixture.db, fastRetry);
    await archiveFixture.db.execute('DROP TABLE pair_schedule_duplicates_archive');
    await archiveFixture.db.execute('CREATE TABLE pair_schedule_duplicates_archive (wrong TEXT)');
    const result = await checkDatabaseReadiness(archiveFixture.db);
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'schema_drift');
    assert.ok(result.missingColumns.includes('pair_schedule_duplicates_archive.original_id'));
    assert.ok(result.missingUniqueConstraints.some(constraint =>
      constraint.table === 'pair_schedule_duplicates_archive'));
  } finally {
    archiveFixture.close();
  }
});

test('the actual pre-ledger main schema remains compatible after migration', async () => {
  const fixture = temporaryDatabase();
  try {
    const legacySql = readFileSync(
      new URL('../fixtures/pre-ledger-main-schema.sql', import.meta.url),
      'utf8',
    );
    await fixture.db.executeMultiple(legacySql);
    const before = await checkDatabaseReadiness(fixture.db);
    assert.equal(before.reason, 'schema_uninitialized');

    await runMigrations(fixture.db, fastRetry);
    const after = await checkDatabaseReadiness(fixture.db);
    assert.equal(after.ready, true);
    assert.deepEqual(after.columnDrift, []);
    assert.deepEqual(after.missingUniqueConstraints, []);
  } finally {
    fixture.close();
  }
});

test('ledger checksum drift and an ahead database fail readiness closed', async () => {
  const checksumFixture = temporaryDatabase();
  try {
    await runMigrations(checksumFixture.db, fastRetry);
    await checksumFixture.db.execute({
      sql: 'UPDATE schema_migrations SET checksum=? WHERE version=1',
      args: ['0'.repeat(64)],
    });
    const checksum = await checkDatabaseReadiness(checksumFixture.db);
    assert.equal(checksum.ready, false);
    assert.equal(checksum.status, 'schema_invalid');
    assert.equal(checksum.reason, 'schema_mismatch');
    assert.equal(checksum.issues[0].code, 'schema_mismatch');
  } finally {
    checksumFixture.close();
  }

  const aheadFixture = temporaryDatabase();
  try {
    await runMigrations(aheadFixture.db, fastRetry);
    await aheadFixture.db.execute({
      sql: `INSERT INTO schema_migrations (version,name,checksum,execution_ms)
        VALUES (?,?,?,?)`,
      args: [LATEST_SCHEMA_VERSION + 1, 'future_migration', 'f'.repeat(64), 0],
    });
    const ahead = await checkDatabaseReadiness(aheadFixture.db);
    assert.equal(ahead.ready, false);
    assert.equal(ahead.status, 'schema_invalid');
    assert.equal(ahead.reason, 'schema_ahead');
    assert.equal(ahead.currentVersion, LATEST_SCHEMA_VERSION + 1);
    assert.equal(ahead.issues[0].code, 'schema_ahead');
  } finally {
    aheadFixture.close();
  }
});

test('an unavailable or closed database reports unreachable without throwing', async () => {
  const missing = await checkDatabaseReadiness(null);
  assert.equal(missing.ready, false);
  assert.equal(missing.status, 'unreachable');
  assert.equal(missing.reason, 'database_unreachable');

  const fixture = temporaryDatabase();
  fixture.closeClient();
  try {
    const closed = await checkDatabaseReadiness(fixture.db);
    assert.equal(closed.ready, false);
    assert.equal(closed.status, 'unreachable');
    assert.equal(closed.reason, 'database_unreachable');
    assert.equal(closed.issues[0].code, 'database_unreachable');
  } finally {
    fixture.close();
  }
});

test('readiness uses only read-only SELECT and PRAGMA statements', async () => {
  const fixture = temporaryDatabase();
  try {
    await runMigrations(fixture.db, fastRetry);
    const statements = [];
    const readOnlyClient = {
      execute(statement) {
        const sql = typeof statement === 'string' ? statement : statement.sql;
        statements.push(sql);
        assert.match(sql.trim(), /^(?:SELECT|PRAGMA)\b/i, `unexpected readiness write: ${sql}`);
        return fixture.db.execute(statement);
      },
    };

    const result = await checkDatabaseReadiness(readOnlyClient);
    assert.equal(result.ready, true);
    assert.ok(statements.length <= 5, `readiness used ${statements.length} database calls`);
    assert.ok(statements.some(sql => /pragma_table_info/i.test(sql)));
    assert.ok(statements.some(sql => /pragma_index_xinfo/i.test(sql)));
    assert.ok(statements.some(sql => /pragma_foreign_key_list/i.test(sql)));
    assert.ok(statements.some(sql => /^SELECT\b/i.test(sql.trim())));
  } finally {
    fixture.close();
  }
});
