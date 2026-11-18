import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '@libsql/client';
import { createMigratedDatabase } from '../support/migrated-db.mjs';
import { admitExecution, executionQueueReadiness, finishExecution, readExecutionQueueHealth, ExecutionBusyError, sendExecutionBusy } from '../../api/_execution-queue.js';
import { executeProgram } from '../../api/_execution.js';
import { classifyExecutionError, runExecutionSmoke, EXECUTION_SMOKE_EXPECTED_OUTPUT } from '../../api/_execution-smoke.js';
import { assessExecutionSmoke, main as assessCli } from '../../scripts/github-execution-smoke.mjs';
import { readAdminDiagnostics } from '../../api/_admin-diagnostics.js';
const ENV={EXECUTION_QUEUE_ENABLED:'true',EXECUTION_PROVIDER:'vercel-sandbox',JWT_SECRET:'execution-r2-errors-test-secret'.repeat(2)};
const ctx={userId:1,circleId:1,operation:'fixture'};
async function fixture(t){const file=await createMigratedDatabase({prefix:'randori-468-r2-errors-'}),db=createClient({url:file.url});
  t.after(()=>{db.close();file.cleanup();});await db.execute("INSERT INTO circles(id,public_id,slug,name,is_primary) VALUES(1,'errors','errors','Errors',1)");return db;}

test('all repo retry conflict codes retry before commit, never write metrics while the lock is held',async t=>{
  const db=await fixture(t);let held=false;
  const execute=async s=>{const sql=typeof s==='string'?s:s.sql;if(sql.includes('execution_queue_metric'))assert.equal(held,false);return db.execute(s);};
  for(const code of ['SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED','SQLITE_LOCKED_SHAREDCACHE','TRANSACTION_CONFLICT','LIBSQL_TRANSACTION_BUSY']){
    let attempts=0;
    const client={execute,transaction:async()=>{if(++attempts===1)throw Object.assign(new Error('conflict'),{cause:{code}});
      const tx=await db.transaction('write');held=true;return{execute:s=>tx.execute(s),batch:s=>tx.batch(s),
        rollback:async()=>{await tx.rollback();held=false;},commit:async()=>{await tx.commit();held=false;},close:()=>tx.close()};}};
    const lease=await admitExecution(client,ctx,{env:ENV,random:()=>0});assert.equal(attempts,2);await finishExecution(client,lease,{safeToRelease:true});
  }
});

test('four exhausted conflict attempts and non-retryable store failures are recorded and degrade admin health',async t=>{
  const db=await fixture(t);let attempts=0;
  const broken={execute:s=>db.execute(s),transaction:async()=>{attempts++;throw Object.assign(new Error('conflict'),{code:'SQLITE_BUSY'});}};
  await assert.rejects(admitExecution(broken,ctx,{env:ENV,random:()=>0}),e=>e instanceof ExecutionBusyError&&e.reason==='store');assert.equal(attempts,4);
  const before=await readExecutionQueueHealth(db,{env:ENV});assert.equal(before.recent.store,1);assert.equal(before.healthy,false);assert.equal(before.activeUnits,0);
  const snapshot=await readAdminDiagnostics(db,{env:ENV,checkReadiness:async()=>({ready:true})});assert.equal(snapshot.cards.execution.status,'degraded');assert.equal(snapshot.cards.execution.category,'admission_refused');
  attempts=0;broken.transaction=async()=>{attempts++;throw Object.assign(new Error('down'),{code:'NETWORK_ERROR'});};
  await assert.rejects(admitExecution(broken,ctx,{env:ENV}),ExecutionBusyError);assert.equal(attempts,1);
  assert.equal((await readExecutionQueueHealth(db,{env:ENV})).recent.store,2);
});

test('native SQLite COMMIT conflict retries only after its open transaction is confirmed rolled back',async t=>{
  const db=await fixture(t);let attempts=0,rollbacks=0;
  const client={protocol:'file',execute:s=>db.execute(s),transaction:async()=>{
    const tx=await db.transaction('write');const first=++attempts===1;return{get closed(){return tx.closed;},execute:s=>tx.execute(s),batch:s=>tx.batch(s),close:()=>tx.close(),
      rollback:async()=>{await tx.rollback();rollbacks++;},commit:async()=>{if(first)throw Object.assign(new Error('locked'),{code:'SQLITE_BUSY'});await tx.commit();}};
  }};
  const lease=await admitExecution(client,ctx,{env:ENV,random:()=>0});assert.equal(attempts,2);assert.equal(rollbacks,1);assert.ok(lease);
  const health=await readExecutionQueueHealth(db,{env:ENV});assert.equal(health.spend.usedDayUnits,1);assert.equal(health.recent.admitted,1);assert.equal(health.recent.store,0);
});

test('ambiguous commit is never retried, its possible lease is retained, and store refusal is visible',async t=>{
  const db=await fixture(t);let attempts=0;
  const client={execute:s=>db.execute(s),transaction:async()=>{attempts++;const tx=await db.transaction('write');return{
    execute:s=>tx.execute(s),batch:s=>tx.batch(s),rollback:()=>tx.rollback(),close:()=>tx.close(),
    commit:async()=>{await tx.commit();throw Object.assign(new Error('lost reply'),{code:'LIBSQL_TRANSACTION_BUSY'});}};}};
  await assert.rejects(admitExecution(client,ctx,{env:ENV}),e=>e.reason==='store');assert.equal(attempts,1);
  const health=await readExecutionQueueHealth(db,{env:ENV});assert.equal(health.activeUnits,1);assert.equal(health.recent.store,1);
});

test('all snapshot settings validate before lease/quota spend and missing primary circle fails readiness',async t=>{
  const db=await fixture(t);let provider=0;
  assert.deepEqual(await executionQueueReadiness(db,ENV),{ready:true});
  for(const key of ['EXECUTION_WARM_JAVASCRIPT_SNAPSHOT_ID','EXECUTION_WARM_PYTHON_SNAPSHOT_ID']){
    const env={...ENV,[key]:'bad PRIVATE_PROVIDER_CONFIG'};
    await assert.rejects(executeProgram({language:'javascript',source:'PRIVATE_SOURCE'},{env,db,executionContext:ctx,loadSandboxSdk:async()=>{provider++;return{};}}),e=>e.reason==='configuration');
    const health=await readExecutionQueueHealth(db,{env});assert.equal(health.ready,false);assert.equal(health.reason,'configuration');assert.equal(health.activeUnits,0);
    assert.doesNotMatch(JSON.stringify(health),/PRIVATE/);
  }
  assert.equal(provider,0);assert.equal((await readExecutionQueueHealth(db,{env:ENV})).recent.configuration,2);
  await db.execute("UPDATE circles SET archived_at=datetime('now') WHERE id=1");
  assert.deepEqual(await executionQueueReadiness(db,ENV),{ready:false,reason:'primary_circle'});
  assert.deepEqual(await executionQueueReadiness(new Proxy({}, {get(){throw new Error('I/O');}}),{}),{ready:true});
});

test('daily quota supplies a fixed reset instant and window rather than asking for a 24h live countdown',async t=>{
  const db=await fixture(t),env={...ENV,EXECUTION_GLOBAL_PER_DAY:'1'};
  const lease=await admitExecution(db,ctx,{env});await finishExecution(db,lease,{safeToRelease:true});
  let error;try{await admitExecution(db,{...ctx,userId:2},{env});}catch(e){error=e;}
  assert.equal(error.reason,'quota');assert.equal(error.quotaWindow,'day');assert.match(error.resetAt,/T00:00:00.000Z$/);
  const res={setHeader(){},status(n){this.statusCode=n;return this;},json(body){return body;}};
  const body=sendExecutionBusy(res,error);assert.equal(res.statusCode,429);assert.equal(body.quota_window,'day');assert.equal(body.reset_at,error.resetAt);
});

test('busy smoke is explicit deferred evidence, never a provider error or a verified passing smoke',async t=>{
  const db=await fixture(t);
  assert.equal(classifyExecutionError(new ExecutionBusyError('queued')),'busy');assert.equal(classifyExecutionError(new ExecutionBusyError('configuration')),'misconfigured');
  const result=await runExecutionSmoke({trigger:'schedule',getDb:()=>db,env:ENV,execute:async request=>{
    if(request.language==='javascript')throw new ExecutionBusyError('queued');return{stdout:EXECUTION_SMOKE_EXPECTED_OUTPUT,code:0};}});
  assert.equal(result.body.languages.javascript.status,'busy');assert.equal(result.body.ok,true);
  const assessment=assessExecutionSmoke(result.body);assert.equal(assessment.ok,true);assert.equal(assessment.category,'execution_busy');
  let text='';const cli=await assessCli({environment:{APP_URL:'https://example.invalid',CRON_SECRET:'fixture',EXECUTION_SMOKE_TIMEOUT_MS:'1000',EXECUTION_SMOKE_TRIGGER:'schedule'},
    fetchImpl:async()=>new Response(JSON.stringify(result.body)),stdout:{write:s=>{text+=s;}}});
  assert.equal(cli.exitCode,0);assert.equal(cli.result.status,'deferred');assert.match(text,/no provider pass is asserted/);assert.doesNotMatch(text,/::error/);
  const snapshot=await readAdminDiagnostics(db,{env:ENV,checkReadiness:async()=>({ready:true})});assert.equal(snapshot.cards.execution.smoke.status,'busy');assert.notEqual(snapshot.cards.execution.status,'healthy');
});
