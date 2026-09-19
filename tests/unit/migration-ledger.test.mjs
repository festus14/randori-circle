import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  EXECUTABLE_MIGRATIONS,
  LATEST_MIGRATION_VERSION,
  checksumExecutableMigration,
  validateExecutableMigrations,
} from '../../db/executable-migrations.js';
import {
  MIGRATION_LEDGER_CHECKSUM,
  MigrationLedgerError,
  assertMigrationLedgerContract,
  createMigrationLedger,
  insertMigrationLedgerRow,
  readMigrationLedger,
  validateMigrationLedger,
} from '../../db/migration-ledger.js';

function temporaryDatabase(){
  const directory=mkdtempSync(join(tmpdir(),'randori-ledger-'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

test('executable migrations are contiguous and fingerprint every executable operation',()=>{
  assert.equal(validateExecutableMigrations(),true);
  assert.equal(LATEST_MIGRATION_VERSION,15);
  assert.deepEqual(EXECUTABLE_MIGRATIONS.slice(0,2).map(migration=>migration.checksum),[
    '27944847696265114fbbb0e70ffa961a7f766a8f85cc4fe251ef00a779aac0df',
    'ceca22b30cc4f546359dc8d5731e1ab157e82b748b468e6eed510a8a4379444d',
  ]);
  assert.equal(EXECUTABLE_MIGRATIONS[2].checksum,'dd467c77944b1da0b722ddd91ebef1071811fb24c65fdff7d2121b67fb204270');
  assert.equal(EXECUTABLE_MIGRATIONS[3].checksum,'99e63a04a8617d4dcc12d5ff71ac8590e21ba5a44bdcaba90ead405f42f5625e');
  assert.equal(EXECUTABLE_MIGRATIONS[4].checksum,'cad0dcadb3b75ae267dd6d7ff9393507e122f0d104e648357631a1c4af0b98ad');
  assert.equal(EXECUTABLE_MIGRATIONS[5].checksum,'e62bdb26e9055eeae387e80bbd3dba08130228bf9a42673b2fceecddd9fc2f6b');
  assert.equal(EXECUTABLE_MIGRATIONS[6].checksum,'2f904882cdc996c63492794b7e321560cbe3574871984e51e2d3075b897e95e1');
  assert.equal(EXECUTABLE_MIGRATIONS[7].checksum,'60059dfffd4d333e5b90a8eea32f23bc2165a8019911e4b006deeb0f2b68929c');
  assert.equal(EXECUTABLE_MIGRATIONS[8].checksum,'226c58e70d0f7dfeae89449dcc567f52afeed46c19c2f9987c510f78029ec560');
  assert.equal(EXECUTABLE_MIGRATIONS[9].checksum,'df6508898b4b697ca8d21646c9460aefcc7f85d7fc8f2f027ed10342fe98e014');
  assert.equal(EXECUTABLE_MIGRATIONS[10].checksum,'e1e41483cbdff5a10a58ccc144bfadbb818cecb900768495ad8ab64dd393332b');
  assert.equal(EXECUTABLE_MIGRATIONS[11].checksum,'9443e548fb6edac275eb8af08e7bc007cbfa32e5450efaf444375b976eddf43c');
  assert.equal(EXECUTABLE_MIGRATIONS[12].checksum,'54b73ffd4cbc009af58c40110b6387d15c2ec52f7f9c082ef69b1258c691d122');
  assert.equal(EXECUTABLE_MIGRATIONS[14].checksum,'3b715ac6c5f4d4efa6d628bcc01fad8dccc189b855c5dd0ecf7625e1dc3b1a34');
  assert.match(MIGRATION_LEDGER_CHECKSUM,/^[a-f0-9]{64}$/);
  for(const migration of EXECUTABLE_MIGRATIONS){
    assert.equal(checksumExecutableMigration(migration),migration.checksum);
    assert.ok(Object.isFrozen(migration));
    assert.ok(Object.isFrozen(migration.operations));
  }
  assert.equal(EXECUTABLE_MIGRATIONS[1].operations.at(-1).operation,'ensure-row');

  const changed=structuredClone(EXECUTABLE_MIGRATIONS);
  changed[1].operations.at(-1).sql+=' ';
  assert.throws(()=>validateExecutableMigrations(changed),/unsupported state operation|checksum/i);
  assert.throws(()=>validateExecutableMigrations([]),/non-empty migration-plan prefix/i);
});

test('ledger contract and immutable rows are validated exactly',async()=>{
  const fixture=temporaryDatabase();
  try{
    await fixture.db.execute('PRAGMA foreign_keys=ON');
    await fixture.db.execute('PRAGMA ignore_check_constraints=OFF');
    await createMigrationLedger(fixture.db);
    assert.equal(await assertMigrationLedgerContract(fixture.db),true);
    await insertMigrationLedgerRow(fixture.db,EXECUTABLE_MIGRATIONS[0],{
      executionMs:3,
      disposition:'applied',
    });
    const valid=validateMigrationLedger(await readMigrationLedger(fixture.db),EXECUTABLE_MIGRATIONS);
    assert.equal(valid.currentVersion,1);
    assert.equal(valid.rows[0].disposition,'applied');

    await fixture.db.execute("UPDATE schema_migrations SET applied_at='not-a-date' WHERE version=1");
    assert.throws(
      ()=>validateMigrationLedger([{...
        valid.rows[0],applied_at:'not-a-date',execution_ms:3,
      }],EXECUTABLE_MIGRATIONS),
      error=>error instanceof MigrationLedgerError&&/metadata/i.test(error.message),
    );
    assert.throws(
      ()=>validateMigrationLedger([{...
        valid.rows[0],applied_at:'2026-99-99 99:99:99',execution_ms:3,
      }],EXECUTABLE_MIGRATIONS),
      error=>error instanceof MigrationLedgerError&&/metadata/i.test(error.message),
    );
  }finally{ fixture.close(); }
});

test('ledger rejects gaps, future versions, checksum drift, and owned schema additions',async()=>{
  const fixture=temporaryDatabase();
  try{
    await fixture.db.execute('PRAGMA foreign_keys=ON');
    await createMigrationLedger(fixture.db);
    const row=(version,overrides={})=>({
      version,
      name:EXECUTABLE_MIGRATIONS[version-1]?.name||'future',
      checksum:EXECUTABLE_MIGRATIONS[version-1]?.checksum||'f'.repeat(64),
      applied_at:'2026-09-18 10:00:00',
      execution_ms:0,
      disposition:'applied',
      ...overrides,
    });
    assert.throws(()=>validateMigrationLedger([row(2)],EXECUTABLE_MIGRATIONS),/gap/i);
    assert.throws(()=>validateMigrationLedger([row(1),row(2),row(3),row(4),row(5),row(6),row(7),row(8),row(9),row(10),row(11),row(12),row(13),row(14),row(15),row(16)],EXECUTABLE_MIGRATIONS),/newer/i);
    assert.throws(()=>validateMigrationLedger([row(1,{checksum:'0'.repeat(64)})],EXECUTABLE_MIGRATIONS),/immutable/i);
    assert.throws(()=>validateMigrationLedger([
      row(1),row(2,{disposition:'adopted'}),
    ],EXECUTABLE_MIGRATIONS),/metadata/i);
    assert.throws(()=>validateMigrationLedger([
      row(1,{disposition:'adopted',execution_ms:1}),
    ],EXECUTABLE_MIGRATIONS),/metadata/i);
    assert.equal(validateMigrationLedger([
      row(1,{disposition:'adopted'}),row(2),
    ],EXECUTABLE_MIGRATIONS).currentVersion,2);

    await fixture.db.execute('CREATE INDEX idx_schema_migrations_disposition ON schema_migrations(disposition)');
    await assert.rejects(
      assertMigrationLedgerContract(fixture.db),
      error=>error instanceof MigrationLedgerError&&/unexpected schema objects/i.test(error.message),
    );
  }finally{ fixture.close(); }
});
