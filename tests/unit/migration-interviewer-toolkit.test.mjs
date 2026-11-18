import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { MIGRATION_CONTRACTS } from '../../db/migration-contract.js';
import { inspectMigrationCompatibility } from '../../db/migration-compatibility-check.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import { inspectDatabaseReadiness } from '../../api/_health.js';
import { inspectLedgerReadiness } from '../../db/migration-compatibility.js';
import { interviewerToolkitAvailable } from '../../api/_interviewer-toolkit.js';

export async function database(through=27){
  const dir=mkdtempSync(join(tmpdir(),'randori-toolkit-465-'));
  const db=createClient({url:`file:${join(dir,'test.db')}`});
  await prepareMigrationConnection(db);
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,through);
  const before=await inspectMigrationState(db,{migrations});
  await applyMigrations(db,{migrations,expectedStateFingerprint:before.stateFingerprint,retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  return {db,close(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
export async function seedPair(db){
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
    (1,'one@example.test','hash','One','#111'),(2,'two@example.test','hash','Two','#222'),(9,'outside@example.test','hash','Outside','#999')`);
  await db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start) VALUES(10,'2026-W47','2026-11-15T08:00:00.000Z')`);
  await db.execute(`INSERT INTO pairing_groups(id,week_id,user_a_id,user_b_id,is_ai_pair) VALUES(20,10,1,2,0)`);
  await db.execute(`INSERT INTO pairing_participants(week_id,user_id,position,source) VALUES(10,1,0,'auth'),(10,2,1,'auth')`);
}

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
