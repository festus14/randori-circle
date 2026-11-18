import assert from 'node:assert/strict';

import test from 'node:test';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { MIGRATION_CONTRACTS } from '../../db/migration-contract.js';
import { inspectMigrationCompatibility } from '../../db/migration-compatibility-check.js';
import { applyMigrations, inspectMigrationState } from '../../db/migration-runner.js';
import { inspectDatabaseReadiness } from '../../api/_health.js';
import { inspectLedgerReadiness } from '../../db/migration-compatibility.js';
import { interviewerToolkitAvailable } from '../../api/_interviewer-toolkit.js';

import { database, seedPair } from '../support/interviewer-toolkit.mjs';

test('v27 is additive, ledger-pinned, and owns only a new table, indexes and guards',()=>{
  const migration=EXECUTABLE_MIGRATIONS[26],contract=MIGRATION_CONTRACTS[26];
  assert.equal(contract.compatibility,'additive');
  assert.deepEqual(migration.operations.map(op=>op.name),Object.values(contract.introduces).flat());
  assert.ok(migration.operations.filter(op=>op.operation==='ensure-trigger').every(op=>op.table==='interview_evaluations'));
  assert.deepEqual(inspectMigrationCompatibility({migrations:EXECUTABLE_MIGRATIONS}),[]);
});
test('real managed v26 remains READY/pending_additive before protected v27 apply; no schema or rows change on capability reads',async()=>{
  const item=await database(26);
  try{
    const before=await inspectMigrationState(item.db);
    assert.equal(before.currentVersion,26);
    assert.equal(await inspectDatabaseReadiness(item.db),true);
    const ledger=await inspectLedgerReadiness(item.db);
    assert.equal(ledger.state,'pending_additive');
    process.env.INTERVIEWER_TOOLKIT_ENABLED='true';process.env.INTERVIEW_SESSION_ENABLED='true';
    assert.equal(await interviewerToolkitAvailable(item.db),false);
    assert.equal((await inspectMigrationState(item.db)).stateFingerprint,before.stateFingerprint);
    const upgraded=await applyMigrations(item.db,{expectedStateFingerprint:before.stateFingerprint,retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
    assert.deepEqual(upgraded.applied.map(row=>row.version),[27]);
    assert.equal((await item.db.execute('SELECT COUNT(*) AS n FROM interview_evaluations')).rows[0].n,0);
    assert.equal(await inspectDatabaseReadiness(item.db),true);
  }finally{delete process.env.INTERVIEWER_TOOLKIT_ENABLED;delete process.env.INTERVIEW_SESSION_ENABLED;item.close();}
});
test('v25 is not a ready deployment base for code whose additive latest migration is v27',async()=>{
  const item=await database(25);try{
    assert.equal(await inspectDatabaseReadiness(item.db),false);
    assert.equal((await inspectLedgerReadiness(item.db)).state,'behind');
  }finally{item.close();}
});

test('v27 database enforces scores, bounds, ownership, immutable lifetime and CAS revision',async()=>{
  const item=await database();
  try{
    await seedPair(item.db);
    const insert=`INSERT INTO interview_evaluations(week_id,pair_group_id,evaluator_user_id,candidate_user_id,problem_solving,notes,decision,revision,created_at,updated_at,expires_at) VALUES(10,20,?,?,?,?,'hire',1,100,100,7776100)`;
    for(const args of [[1,2,1,''],[9,1,1,''],[2,1,5,''],[2,1,1,'x'.repeat(4001)]]) await assert.rejects(()=>item.db.execute({sql:insert,args}));
    await item.db.execute({sql:insert,args:[2,1,4,'private']});
    for(const sql of ['UPDATE interview_evaluations SET revision=3','UPDATE interview_evaluations SET notes=\'changed\'','UPDATE interview_evaluations SET revision=2,evaluator_user_id=1,candidate_user_id=2','UPDATE interview_evaluations SET revision=2,expires_at=7776101']) await assert.rejects(()=>item.db.execute(sql));
    await item.db.execute("UPDATE interview_evaluations SET revision=2,notes='updated',updated_at=101");
    await item.db.execute('DELETE FROM pairing_groups WHERE id=20');
    assert.equal((await item.db.execute('SELECT COUNT(*) AS n FROM interview_evaluations')).rows[0].n,0);
  }finally{item.close();}
});
