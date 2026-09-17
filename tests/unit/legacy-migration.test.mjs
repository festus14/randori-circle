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
import { checkDatabaseReadiness } from '../../db/readiness.js';

const legacySchema = readFileSync(
  new URL('../fixtures/pre-ledger-main-schema.sql', import.meta.url),
  'utf8',
);

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'randori-legacy-migration-'));
  const db = createClient({ url: `file:${join(directory, 'legacy.sqlite')}` });
  return {
    db,
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function tableCounts(db) {
  const result = await db.execute(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  const counts = {};
  for (const row of result.rows) {
    const name = String(row.name);
    const count = await db.execute(`SELECT COUNT(*) AS count FROM "${name}"`);
    counts[name] = Number(count.rows[0].count);
  }
  return counts;
}

test('the main-branch pre-ledger schema migrates without losing representative production data', async () => {
  const fixture = temporaryDatabase();
  try {
    await fixture.db.executeMultiple(legacySchema);
    const ledgerBefore = await fixture.db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    );
    assert.equal(ledgerBefore.rows.length, 0, 'historical fixture must remain pre-ledger');
    const countsBefore = await tableCounts(fixture.db);

    const migrated = await runMigrations(fixture.db, {
      maxAttempts: 6,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    assert.equal(migrated.fromVersion, 0);
    assert.equal(migrated.toVersion, LATEST_SCHEMA_VERSION);
    assert.deepEqual(migrated.applied.map(item => item.version), MIGRATIONS.map(item => item.version));

    const countsAfter = await tableCounts(fixture.db);
    for (const [table, count] of Object.entries(countsBefore)) {
      assert.equal(countsAfter[table], count, `${table} row count changed during migration`);
    }

    const account = await fixture.db.execute('SELECT * FROM auth_accounts WHERE id=101');
    assert.equal(account.rows[0].email, 'aya@example.test');
    assert.equal(account.rows[0].display_name, 'Aya');
    assert.equal(account.rows[0].google_sub, 'google-aya');
    assert.equal(account.rows[0].phone, '+447700900101');

    const pair = await fixture.db.execute(`SELECT pw.week_label,pg.topic,pg.user_a_id,pg.user_b_id
      FROM pairing_groups pg JOIN pairing_weeks pw ON pw.id=pg.week_id WHERE pg.id=301`);
    assert.deepEqual(
      {
        weekLabel: pair.rows[0].week_label,
        topic: pair.rows[0].topic,
        userA: Number(pair.rows[0].user_a_id),
        userB: Number(pair.rows[0].user_b_id),
      },
      {
        weekLabel: '2026-W37',
        topic: 'Graphs and API design',
        userA: 101,
        userB: 102,
      },
    );

    const schedule = await fixture.db.execute('SELECT * FROM pair_schedules WHERE id=702');
    assert.equal(schedule.rows[0].proposed_times, '["2026-09-09T18:00:00Z"]');
    assert.equal(schedule.rows[0].agreed_time, '2026-09-09T18:00:00Z');

    const session = await fixture.db.execute(`SELECT s.transcript,f.feedback_json
      FROM ai_sessions s JOIN ai_feedback f ON f.session_id=s.id WHERE s.id=601`);
    assert.equal(session.rows[0].transcript, 'Discussed hash maps');
    assert.equal(session.rows[0].feedback_json, '{"summary":"Clear collaboration"}');

    const run = await fixture.db.execute('SELECT * FROM session_runs WHERE id=1001');
    assert.equal(run.rows[0].code, 'return [0,1];');
    assert.equal(Number(run.rows[0].passed_count), 2);

    const snapshot = await fixture.db.execute(
      "SELECT * FROM pair_room_snapshots WHERE room_id='week_201_pair_301'",
    );
    assert.equal(Number(snapshot.rows[0].revision), 4);
    assert.equal(snapshot.rows[0].code, 'function twoSum() { return [0, 1]; }');

    const outbox = await fixture.db.execute('SELECT * FROM pairing_email_outbox WHERE id=1101');
    assert.equal(outbox.rows[0].status, 'sent');
    assert.equal(Number(outbox.rows[0].attempt_count), 1);

    const readiness = await checkDatabaseReadiness(fixture.db);
    assert.equal(readiness.ready, true);
    assert.equal(readiness.currentVersion, LATEST_SCHEMA_VERSION);
  } finally {
    fixture.close();
  }
});
