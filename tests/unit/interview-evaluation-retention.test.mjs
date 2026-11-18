import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { database, seedPair } from '../support/interviewer-toolkit.mjs';
import { runEvaluationRetention } from '../../scripts/interview-evaluation-retention.mjs';
let item;
afterEach(()=>{item?.close();item=null;delete process.env.INTERVIEW_EVALUATION_PURGE_ENABLED;});
test('retention CLI refuses ambiguous, remote, missing and unconfirmed targets before writing',async()=>{
  for(const args of [[],['--database','https://example.test/db'],['--database','file:///tmp/toolkit-no-such-465.db'],['--bad'],['--database']])await assert.rejects(()=>runEvaluationRetention(args));
  item=await database();await assert.rejects(()=>runEvaluationRetention(['--database',item.url,'--purge']),/confirmation/);
});
test('retention CLI defaults read-only and requires both explicit purge and deployment switch',async()=>{
  item=await database();await seedPair(item.db);
  await item.db.execute(`INSERT INTO interview_evaluations(week_id,pair_group_id,evaluator_user_id,candidate_user_id,notes,decision,revision,created_at,updated_at,expires_at) VALUES(10,20,2,1,'expired','hire',1,100,100,7776100)`);
  const args=['--database',item.url];
  assert.deepEqual(await runEvaluationRetention(args),{ok:true,mode:'dry_run',eligible:1,deleted:0});
  const purge=[...args,'--purge','--confirm','DELETE_EXPIRED_INTERVIEW_EVALUATIONS'];
  assert.equal((await runEvaluationRetention(purge)).disabled,true);
  process.env.INTERVIEW_EVALUATION_PURGE_ENABLED='true';assert.equal((await runEvaluationRetention(purge)).deleted,1);
  assert.equal((await runEvaluationRetention(args)).eligible,0);
});
test('retention CLI tolerates a real v26 file without creating any v27 artifacts',async()=>{
  item=await database(26);assert.deepEqual(await runEvaluationRetention(['--database',item.url]),{ok:true,not_installed:true,eligible:0,deleted:0});
});
