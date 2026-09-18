import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  MigrationError,
  MigrationLedgerError,
  MigrationPreflightError,
  runMigrations,
  validateMigrationManifest,
} from '../../db/migrate.js';
import {
  checksumMigrationPlan,
  executeMigrationPlan,
  SCHEDULE_ARCHIVE_TABLE,
} from '../../db/migrations/index.js';
import {
  APPLICATION_TABLES,
  LEGACY_COLUMN_ADDITIONS,
  REQUIRED_INDEXES,
} from '../../db/schema.js';

const fastRetry = Object.freeze({ maxAttempts: 6, baseDelayMs: 0, maxDelayMs: 0 });

function temporaryDatabase(clientCount = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'randori-migrations-'));
  const url = `file:${join(directory, 'test.sqlite')}`;
  const clients = Array.from({ length: clientCount }, () => createClient({ url }));
  return {
    clients,
    db: clients[0],
    close() {
      for (const client of clients) client.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function objectNames(db, type) {
  const result = await db.execute({
    sql: 'SELECT name FROM sqlite_master WHERE type = ? ORDER BY name',
    args: [type],
  });
  return result.rows.map(row => String(row.name));
}

async function ledgerVersions(db) {
  const result = await db.execute('SELECT version FROM schema_migrations ORDER BY version');
  return result.rows.map(row => Number(row.version));
}

function migration(version, name, up) {
  return {
    version,
    name,
    checksum: String(version).repeat(64),
    up,
  };
}

test('migration manifest is contiguous, immutable, and executable', () => {
  assert.equal(validateMigrationManifest(MIGRATIONS), true);
  assert.equal(LATEST_SCHEMA_VERSION, MIGRATIONS.length);
  assert.deepEqual(MIGRATIONS.map(item => item.version), [1, 2, 3, 4]);
  assert.deepEqual(MIGRATIONS.map(item => item.checksum), [
    '91e4e110f9d619dc52051b570fddb0cb3e67a0f8be624837fb71e915279b7618',
    '75d210f7f1b92559c9d3c449227dd5274a320de0f52bd560bf24fad046b79f80',
    'b44d3b14adc133d5e9a5ba05b889a977a86f29f79f518c8e74efb1c3c06c5f16',
    '9336a43511012fef7d5566cf545ccc47567eb6669b82c982e390a9e9764bd7b6',
  ]);

  for (const item of MIGRATIONS) {
    assert.equal(checksumMigrationPlan(item), item.checksum);
    assert.ok(Object.isFrozen(item.operations));
    assert.ok(item.operations.every(operation => Object.isFrozen(operation)));
  }

  const noop = async () => {};
  const valid = migration(1, 'one', noop);
  const invalidManifests = [
    [],
    [{ ...valid, version: 2 }],
    [{ ...valid, name: '' }],
    [{ ...valid, checksum: 'not-a-checksum' }],
    [{ ...valid, up: null }],
  ];
  for (const manifest of invalidManifests) {
    assert.throws(
      () => validateMigrationManifest(manifest),
      error => error instanceof MigrationLedgerError && error.code === 'MIGRATION_LEDGER_INVALID',
    );
  }
});

test('migration fingerprints cover executable SQL, metadata, and operation order', async () => {
  const fingerprint = migration => checksumMigrationPlan(migration);
  const clonePlan = migration => ({
    version: migration.version,
    name: migration.name,
    operations: structuredClone(migration.operations),
  });
  const changedSql = clonePlan(MIGRATIONS[0]);
  changedSql.operations[0].sql += ' ';
  assert.notEqual(fingerprint(changedSql), MIGRATIONS[0].checksum);

  const changedIndexContract = clonePlan(MIGRATIONS[0]);
  const indexOperation = changedIndexContract.operations.find(item => item.operation === 'ensure-index');
  indexOperation.definition.unique = !indexOperation.definition.unique;
  indexOperation.definition.columns.reverse();
  assert.notEqual(fingerprint(changedIndexContract), MIGRATIONS[0].checksum);

  const changedGuard = clonePlan(MIGRATIONS[1]);
  changedGuard.operations[0].inspectSql += ' ';
  assert.notEqual(fingerprint(changedGuard), MIGRATIONS[1].checksum);

  const changedPreflight = clonePlan(MIGRATIONS[3]);
  changedPreflight.operations[0].error.fields[0].target = 'differentTarget';
  assert.notEqual(fingerprint(changedPreflight), MIGRATIONS[3].checksum);

  const reordered = clonePlan(MIGRATIONS[2]);
  [reordered.operations[0], reordered.operations[1]] = [
    reordered.operations[1],
    reordered.operations[0],
  ];
  assert.notEqual(fingerprint(reordered), MIGRATIONS[2].checksum);

  const executed = [];
  const guardPlan = MIGRATIONS[1].operations;
  await executeMigrationPlan({
    execute: async sql => {
      executed.push(sql);
      return { rows: [] };
    },
  }, guardPlan);
  assert.deepEqual(executed, guardPlan.flatMap(operation => [operation.inspectSql, operation.sql]));
});

test('same-name incompatible legacy indexes fail before the ledger is created', async () => {
  const fixtures = [
    {
      table: `CREATE TABLE pair_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week_id INTEGER NOT NULL,
        pair_group_id INTEGER NOT NULL,
        proposed_times TEXT,
        agreed_time TEXT,
        created_at TEXT,
        updated_at TEXT
      )`,
      index: 'CREATE INDEX uq_pair_schedules_week_pair ON pair_schedules(week_id,pair_group_id)',
      expected: 'uq_pair_schedules_week_pair',
    },
    {
      table: `CREATE TABLE session_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        question_slug TEXT,
        created_at TEXT
      )`,
      index: 'CREATE INDEX idx_runs_user ON session_runs(created_at DESC,user_id)',
      expected: 'idx_runs_user',
    },
  ];

  for (const scenario of fixtures) {
    const fixture = temporaryDatabase();
    try {
      await fixture.db.execute(scenario.table);
      await fixture.db.execute(scenario.index);
      await assert.rejects(
        runMigrations(fixture.db, fastRetry),
        error => error instanceof MigrationPreflightError &&
          error.code === 'MIGRATION_PREFLIGHT_FAILED' &&
          error.details?.index === scenario.expected,
      );
      assert.ok(!(await objectNames(fixture.db, 'table')).includes('schema_migrations'));
    } finally {
      fixture.close();
    }
  }
});

test('a fresh database receives the complete canonical schema and ledger', async () => {
  const fixture = temporaryDatabase();
  try {
    const result = await runMigrations(fixture.db, fastRetry);
    assert.equal(result.ok, true);
    assert.equal(result.fromVersion, 0);
    assert.equal(result.toVersion, LATEST_SCHEMA_VERSION);
    assert.deepEqual(result.applied.map(item => item.version), [1, 2, 3, 4]);

    const tables = await objectNames(fixture.db, 'table');
    const indexes = await objectNames(fixture.db, 'index');
    for (const table of [...APPLICATION_TABLES, 'schema_migrations', SCHEDULE_ARCHIVE_TABLE]) {
      assert.ok(tables.includes(table), `missing table ${table}`);
    }
    for (const index of REQUIRED_INDEXES) {
      assert.ok(indexes.includes(index), `missing index ${index}`);
    }

    const ledger = await fixture.db.execute(
      'SELECT version,name,checksum,applied_at,execution_ms FROM schema_migrations ORDER BY version',
    );
    assert.equal(ledger.rows.length, MIGRATIONS.length);
    for (const [index, row] of ledger.rows.entries()) {
      assert.equal(Number(row.version), MIGRATIONS[index].version);
      assert.equal(String(row.name), MIGRATIONS[index].name);
      assert.equal(String(row.checksum), MIGRATIONS[index].checksum);
      assert.ok(String(row.applied_at).length > 0);
      assert.ok(Number(row.execution_ms) >= 0);
    }
  } finally {
    fixture.close();
  }
});

test('legacy columns are added without losing existing account, week, or run data', async () => {
  const fixture = temporaryDatabase();
  try {
    await runMigrations(fixture.db, { ...fastRetry, migrations: MIGRATIONS.slice(0, 1) });
    await fixture.db.execute({
      sql: `INSERT INTO auth_accounts (id,email,password_hash,display_name,color)
        VALUES (?,?,?,?,?)`,
      args: [41, 'legacy@example.test', 'legacy-hash', 'Legacy User', '#123456'],
    });
    await fixture.db.execute({
      sql: `INSERT INTO pairing_weeks (id,week_label,week_start,focus)
        VALUES (?,?,?,?)`,
      args: [51, '2026-W30', '2026-07-20', 'dsa'],
    });
    await fixture.db.execute({
      sql: `INSERT INTO pairing_week_runs
        (week_label,week_id,generation_token,algorithm_version,algorithm_seed,participant_count,participants_json)
        VALUES (?,?,?,?,?,?,?)`,
      args: ['2026-W30', 51, 'legacy-token', 'v0', 'legacy-seed', 2, '[41,42]'],
    });

    for (const { table, column } of LEGACY_COLUMN_ADDITIONS) {
      await fixture.db.execute(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
    }

    const upgraded = await runMigrations(fixture.db, fastRetry);
    assert.equal(upgraded.fromVersion, 1);
    assert.deepEqual(upgraded.applied.map(item => item.version), [2, 3, 4]);

    for (const { table, column } of LEGACY_COLUMN_ADDITIONS) {
      const columns = await fixture.db.execute(`PRAGMA table_info("${table}")`);
      assert.ok(columns.rows.some(row => row.name === column), `${table}.${column} was not restored`);
    }
    const account = await fixture.db.execute('SELECT * FROM auth_accounts WHERE id=41');
    assert.equal(account.rows[0].email, 'legacy@example.test');
    assert.equal(account.rows[0].display_name, 'Legacy User');
    assert.equal(Number(account.rows[0].is_available), 1);
    assert.equal(account.rows[0].interview_focus, 'both');

    const week = await fixture.db.execute('SELECT * FROM pairing_weeks WHERE id=51');
    assert.equal(week.rows[0].week_label, '2026-W30');
    assert.equal(Number(week.rows[0].is_demo), 0);

    const run = await fixture.db.execute(
      "SELECT * FROM pairing_week_runs WHERE week_label='2026-W30'",
    );
    assert.equal(run.rows[0].generation_token, 'legacy-token');
    assert.equal(Number(run.rows[0].generation), 1);
  } finally {
    fixture.close();
  }
});

test('completed migrations are idempotent', async () => {
  const fixture = temporaryDatabase();
  try {
    await runMigrations(fixture.db, fastRetry);
    const second = await runMigrations(fixture.db, fastRetry);
    assert.equal(second.fromVersion, LATEST_SCHEMA_VERSION);
    assert.equal(second.toVersion, LATEST_SCHEMA_VERSION);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(await ledgerVersions(fixture.db), [1, 2, 3, 4]);
  } finally {
    fixture.close();
  }
});

test('a failed migration rolls back atomically and can resume from the last ledger entry', async () => {
  const fixture = temporaryDatabase();
  let shouldFail = true;
  const migrations = [
    migration(1, 'stable_table', async db => {
      await db.execute('CREATE TABLE stable_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    }),
    migration(2, 'resumable_table', async db => {
      await db.execute('CREATE TABLE resumable_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      await db.execute("INSERT INTO resumable_records (id,value) VALUES (1,'inside-transaction')");
      if (shouldFail) throw new Error('intentional migration failure');
    }),
  ];

  try {
    await assert.rejects(
      runMigrations(fixture.db, { ...fastRetry, migrations }),
      error => error instanceof MigrationError && error.code === 'MIGRATION_FAILED',
    );
    assert.deepEqual(await ledgerVersions(fixture.db), [1]);
    assert.ok((await objectNames(fixture.db, 'table')).includes('stable_records'));
    assert.ok(!(await objectNames(fixture.db, 'table')).includes('resumable_records'));

    shouldFail = false;
    const resumed = await runMigrations(fixture.db, { ...fastRetry, migrations });
    assert.equal(resumed.fromVersion, 1);
    assert.deepEqual(resumed.applied.map(item => item.version), [2]);
    const rows = await fixture.db.execute('SELECT * FROM resumable_records');
    assert.deepEqual(rows.rows.map(row => ({ id: Number(row.id), value: row.value })), [
      { id: 1, value: 'inside-transaction' },
    ]);
  } finally {
    fixture.close();
  }
});

test('concurrent migrators converge and retry a real database lock', async () => {
  const fixture = temporaryDatabase(2);
  const [firstDb, secondDb] = fixture.clients;
  let releaseFirst;
  let announceFirst;
  const firstEntered = new Promise(resolve => { announceFirst = resolve; });
  const releaseGate = new Promise(resolve => { releaseFirst = resolve; });
  const failsafe=setTimeout(()=>releaseFirst?.(),2000);
  failsafe.unref?.();
  let retryCount = 0;
  let upCalls = 0;
  const migrations = [
    migration(1, 'concurrent_table', async db => {
      upCalls += 1;
      await db.execute('CREATE TABLE concurrent_records (id INTEGER PRIMARY KEY)');
      announceFirst();
      await releaseGate;
    }),
  ];

  try {
    await firstDb.execute('PRAGMA busy_timeout=1');
    await secondDb.execute('PRAGMA busy_timeout=1');
    const first = runMigrations(firstDb, { ...fastRetry, migrations });
    await firstEntered;
    const second = runMigrations(secondDb, {
      ...fastRetry,
      migrations,
      sleep: async () => {
        retryCount += 1;
        releaseFirst();
        // Give the winning transaction a deterministic scheduling turn to
        // commit before the losing migrator opens a fresh transaction.
        await new Promise(resolve => setTimeout(resolve, 5));
      },
    });

    const results = await Promise.all([first, second]);
    assert.ok(retryCount >= 1, 'the competing migrator should observe and retry SQLITE_BUSY');
    assert.equal(upCalls, 1, 'the migration body must execute exactly once');
    assert.equal(results.reduce((count, result) => count + result.applied.length, 0), 1);
    assert.ok(results.every(result => result.toVersion === 1));
    assert.deepEqual(await ledgerVersions(firstDb), [1]);
  } finally {
    clearTimeout(failsafe);
    releaseFirst?.();
    fixture.close();
  }
});

test('ledger gaps, future versions, and checksum changes fail closed', async () => {
  const cases = [
    {
      mutate: db => db.execute('DELETE FROM schema_migrations WHERE version=2'),
      pattern: /gap/i,
    },
    {
      mutate: db => db.execute({
        sql: `INSERT INTO schema_migrations (version,name,checksum,execution_ms)
          VALUES (?,?,?,?)`,
        args: [LATEST_SCHEMA_VERSION + 1, 'future_migration', 'f'.repeat(64), 0],
      }),
      pattern: /newer/i,
    },
    {
      mutate: db => db.execute({
        sql: 'UPDATE schema_migrations SET checksum=? WHERE version=2',
        args: ['0'.repeat(64)],
      }),
      pattern: /checksum/i,
    },
  ];

  for (const scenario of cases) {
    const fixture = temporaryDatabase();
    try {
      await runMigrations(fixture.db, fastRetry);
      await scenario.mutate(fixture.db);
      await assert.rejects(
        runMigrations(fixture.db, fastRetry),
        error => error instanceof MigrationLedgerError && scenario.pattern.test(error.message),
      );
    } finally {
      fixture.close();
    }
  }
});

test('a malformed migration ledger is rejected before any migration runs', async () => {
  const fixture = temporaryDatabase();
  try {
    await fixture.db.execute(`CREATE TABLE schema_migrations (
      version TEXT,
      name TEXT,
      checksum TEXT,
      applied_at TEXT,
      execution_ms TEXT
    )`);
    await assert.rejects(
      runMigrations(fixture.db, fastRetry),
      error => error instanceof MigrationLedgerError &&
        error.code === 'MIGRATION_LEDGER_INVALID' &&
        error.details?.columnDrift?.length > 0,
    );
    assert.deepEqual(await ledgerVersions(fixture.db), []);
    assert.ok(!(await objectNames(fixture.db, 'table')).includes('auth_accounts'));
  } finally {
    fixture.close();
  }
});

test('duplicate schedules are archived, deduplicated by newest id, and then constrained', async () => {
  const fixture = temporaryDatabase();
  try {
    await runMigrations(fixture.db, { ...fastRetry, migrations: MIGRATIONS.slice(0, 2) });
    await fixture.db.execute(`INSERT INTO pair_schedules
      (id,week_id,pair_group_id,proposed_times,agreed_time,created_at,updated_at) VALUES
      (10,7,8,'["old"]',NULL,'2026-01-01','2026-01-01'),
      (11,7,8,'["middle"]',NULL,'2026-01-02','2026-01-02'),
      (12,7,8,'["new"]','2026-01-04','2026-01-03','2026-01-03'),
      (13,7,9,'["only"]',NULL,'2026-01-01','2026-01-01')`);

    await runMigrations(fixture.db, fastRetry);
    const schedules = await fixture.db.execute(
      'SELECT id,week_id,pair_group_id,proposed_times FROM pair_schedules ORDER BY id',
    );
    assert.deepEqual(schedules.rows.map(row => Number(row.id)), [12, 13]);
    assert.equal(schedules.rows[0].proposed_times, '["new"]');

    const archive = await fixture.db.execute(
      `SELECT original_id,proposed_times,archive_reason FROM ${SCHEDULE_ARCHIVE_TABLE} ORDER BY original_id`,
    );
    assert.deepEqual(archive.rows.map(row => Number(row.original_id)), [10, 11]);
    assert.deepEqual(archive.rows.map(row => row.proposed_times), ['["old"]', '["middle"]']);
    assert.ok(archive.rows.every(row => row.archive_reason === 'duplicate_week_pair'));

    await assert.rejects(
      fixture.db.execute(
        'INSERT INTO pair_schedules (week_id,pair_group_id) VALUES (7,8)',
      ),
      /UNIQUE constraint failed/i,
    );
  } finally {
    fixture.close();
  }
});

test('a conflicting pre-existing schedule archive fails without deleting source rows', async () => {
  const fixture = temporaryDatabase();
  try {
    await runMigrations(fixture.db, { ...fastRetry, migrations: MIGRATIONS.slice(0, 2) });
    await fixture.db.batch([
      `CREATE TABLE ${SCHEDULE_ARCHIVE_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_id INTEGER NOT NULL UNIQUE,
        week_id INTEGER NOT NULL,
        pair_group_id INTEGER NOT NULL,
        proposed_times TEXT,
        agreed_time TEXT,
        created_at TEXT,
        updated_at TEXT,
        archived_at TEXT NOT NULL DEFAULT (datetime('now')),
        archive_reason TEXT NOT NULL
      )`,
      `INSERT INTO ${SCHEDULE_ARCHIVE_TABLE}
        (original_id,week_id,pair_group_id,proposed_times,archive_reason)
        VALUES (10,99,99,'["conflict"]','manual')`,
      `INSERT INTO pair_schedules
        (id,week_id,pair_group_id,proposed_times,created_at,updated_at) VALUES
        (10,7,8,'["old"]','2026-01-01','2026-01-01'),
        (11,7,8,'["new"]','2026-01-02','2026-01-02')`,
    ], 'write');

    await assert.rejects(
      runMigrations(fixture.db, fastRetry),
      error => error instanceof MigrationError && /migration 3/i.test(error.message),
    );
    assert.deepEqual(await ledgerVersions(fixture.db), [1, 2]);
    const schedules = await fixture.db.execute('SELECT id FROM pair_schedules ORDER BY id');
    assert.deepEqual(schedules.rows.map(row => Number(row.id)), [10, 11]);
    const archive = await fixture.db.execute(
      `SELECT week_id,pair_group_id,proposed_times FROM ${SCHEDULE_ARCHIVE_TABLE} WHERE original_id=10`,
    );
    assert.equal(Number(archive.rows[0].week_id), 99);
    assert.equal(archive.rows[0].proposed_times, '["conflict"]');
  } finally {
    fixture.close();
  }
});

test('duplicate pairing-week labels stop at preflight and resume after manual reconciliation', async () => {
  const fixture = temporaryDatabase();
  try {
    await runMigrations(fixture.db, { ...fastRetry, migrations: MIGRATIONS.slice(0, 3) });
    await fixture.db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start,focus) VALUES
      (21,'2026-W40','2026-09-28','dsa'),
      (22,'2026-W40','2026-09-28','system-design')`);

    await assert.rejects(
      runMigrations(fixture.db, fastRetry),
      error => error instanceof MigrationPreflightError &&
        error.code === 'MIGRATION_PREFLIGHT_FAILED' &&
        error.details?.duplicates?.[0]?.weekLabel === '2026-W40',
    );
    assert.deepEqual(await ledgerVersions(fixture.db), [1, 2, 3]);
    const duplicates = await fixture.db.execute(
      "SELECT id FROM pairing_weeks WHERE week_label='2026-W40' ORDER BY id",
    );
    assert.deepEqual(duplicates.rows.map(row => Number(row.id)), [21, 22]);
    assert.ok(!(await objectNames(fixture.db, 'index')).includes('idx_pairing_weeks_week_label'));

    await fixture.db.execute('DELETE FROM pairing_weeks WHERE id=21');
    const resumed = await runMigrations(fixture.db, fastRetry);
    assert.deepEqual(resumed.applied.map(item => item.version), [4]);
    assert.ok((await objectNames(fixture.db, 'index')).includes('idx_pairing_weeks_week_label'));
    await assert.rejects(
      fixture.db.execute(
        "INSERT INTO pairing_weeks (week_label,week_start,focus) VALUES ('2026-W40','2026-09-28','both')",
      ),
      /UNIQUE constraint failed/i,
    );
  } finally {
    fixture.close();
  }
});
