// Coverage package P5: fail-closed validation, fencing, and fault branches of
// api/_chat-retention.js that the scenario tests in chat-retention.test.mjs do
// not reach. Fault injection wraps a real migrated SQLite database so every
// injected failure is checked against real side effects (rows kept, run state).
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  adoptChatRetentionScope,
  ChatRetentionError,
  chatRetentionEvidenceBindingDigest,
  chatRetentionRuntimeConfig,
  chatRetentionScopeRegistrationAvailable,
  chatRetentionScopeRegistrationStatement,
  claimChatRetentionRun,
  enqueueNextChatRetentionRun,
  ensureChatRetentionReadiness,
  heartbeatChatRetentionLease,
  placeChatRetentionHold,
  processChatRetentionBatch,
  readChatRetentionMetrics,
  releaseChatRetentionHold,
  replayChatRetentionRun,
  runChatRetentionWorker,
  setChatRetentionControl,
} from '../../api/_chat-retention.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const DIGEST_A='a'.repeat(64);
const DIGEST_B='b'.repeat(64);
const SCOPE=Object.freeze({scopeKey:'circle:1',circleId:1,weekId:10,pairGroupId:20});
const LOCAL_SCOPE=Object.freeze({scopeKey:'local',circleId:null,weekId:10,pairGroupId:20});

async function fixture(){
  const {directory,url}=await createMigratedDatabase({prefix:'randori-cov-p5-retention-',filename:'test.sqlite'});
  const db=createClient({url});
  await prepareMigrationConnection(db);
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function withFixture(fn){
  const item=await fixture();
  try{ return await fn(item.db); }finally{ item.close(); }
}

function sqlOf(statement){ return String(statement?.sql??statement); }

// Wraps a real client. Each hook receives (sql, next) and may return a result,
// throw, or return undefined to pass the statement through to the database.
function faultDb(db,{execute,tx,batch,commit,rollback,close}={}){
  const route=(hook,target)=>async statement=>{
    const next=()=>target.execute(statement);
    const injected=hook?await hook(sqlOf(statement),next):undefined;
    return injected===undefined?next():injected;
  };
  return {
    execute:route(execute,db),
    batch:(statements,modeValue)=>batch?batch(statements,modeValue,()=>db.batch(statements,modeValue)):db.batch(statements,modeValue),
    async transaction(modeValue){
      const real=await db.transaction(modeValue);
      return {
        execute:route(tx,real),
        commit:()=>commit?commit(real):real.commit(),
        rollback:()=>rollback?rollback(real):real.rollback(),
        close:()=>close?close(real):real.close(),
      };
    },
  };
}

async function clock(db){
  const row=(await db.execute(`SELECT
    strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc,
    strftime('%Y-%m-%dT00:00:00.000Z','now','-90 days') AS cutoff_utc,
    strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes') AS export_completed,
    strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute') AS backup_completed`)).rows[0];
  return {
    now:String(row.now_utc),cutoff:String(row.cutoff_utc),
    exportCompleted:String(row.export_completed),backupCompleted:String(row.backup_completed),
  };
}

function evidenceFor(scopeValue,dbClock,sourceMaxMessageId){
  const backup={digest:DIGEST_A,throughAt:dbClock.cutoff,completedAt:dbClock.backupCompleted,sourceMaxMessageId};
  const exported={digest:DIGEST_B,throughAt:dbClock.cutoff,completedAt:dbClock.exportCompleted,sourceMaxMessageId};
  return {
    scope:scopeValue,
    backup:{...backup,scopeBindingDigest:chatRetentionEvidenceBindingDigest({kind:'backup',scope:scopeValue,...backup})},
    exported:{...exported,scopeBindingDigest:chatRetentionEvidenceBindingDigest({kind:'export',scope:scopeValue,...exported})},
  };
}

async function seedRoom(db,{scopeValue=SCOPE,messages=1}={}){
  const dbClock=await clock(db);
  await db.execute({
    sql:`INSERT INTO chat_retention_scopes (week_id,pair_group_id,scope_key,circle_id) VALUES (?,?,?,?)`,
    args:[scopeValue.weekId,scopeValue.pairGroupId,scopeValue.scopeKey,scopeValue.circleId],
  });
  for(let id=1;id<=messages;id+=1){
    await db.execute({
      sql:`INSERT INTO pair_messages (id,week_id,pair_group_id,sender_id,message,created_at) VALUES (?,?,?,?,?,?)`,
      args:[id,scopeValue.weekId,scopeValue.pairGroupId,2,`private-${id}`,
        new Date(Date.parse(dbClock.cutoff)-id*1000).toISOString()],
    });
  }
  return {dbClock,request:evidenceFor(scopeValue,dbClock,messages)};
}

async function enqueued(db,{mode='purge',scopeValue=SCOPE,messages=1}={}){
  const {dbClock,request}=await seedRoom(db,{scopeValue,messages});
  await setChatRetentionControl(db,{enabled:true,expectedGeneration:0});
  const queued=await enqueueNextChatRetentionRun(db,{mode,...request});
  assert.equal(queued.created,true);
  return {dbClock,request,runId:queued.runId};
}

async function messageCount(db){
  return Number((await db.execute(`SELECT COUNT(*) AS count FROM pair_messages`)).rows[0].count);
}

async function runRow(db){
  return (await db.execute(`SELECT status,last_error_code,failure_count FROM chat_retention_runs`)).rows[0];
}

const isCode=code=>error=>error instanceof ChatRetentionError&&error.code===code;
const isType=pattern=>error=>error instanceof TypeError&&pattern.test(error.message);

test('ChatRetentionError normalizes codes, keeps a cause, and never echoes caller text',()=>{
  const cause=new Error('raw secret');
  const error=new ChatRetentionError('lower_case_ok',{retryable:true,cause});
  assert.equal(error.code,'LOWER_CASE_OK');
  assert.equal(error.retryable,true);
  assert.equal(error.cause,cause);
  assert.equal(error.message,'Chat retention operation failed.');
  assert.equal(new ChatRetentionError('has spaces; DROP TABLE').code,'RETENTION_FAILED');
  assert.equal(new ChatRetentionError().code,'RETENTION_FAILED');
  assert.equal(new ChatRetentionError('X',{retryable:'yes'}).retryable,false);
  assert.equal('cause' in new ChatRetentionError('X'),false);
});

test('runtime configuration defaults to disabled dry runs and rejects unknown modes',()=>{
  assert.deepEqual(chatRetentionRuntimeConfig({}),{enabled:false,mode:'dry_run'});
  assert.deepEqual(chatRetentionRuntimeConfig({CHAT_RETENTION_ENABLED:'TRUE',CHAT_RETENTION_MODE:' Purge '}),
    {enabled:false,mode:'purge'});
  assert.deepEqual(chatRetentionRuntimeConfig({CHAT_RETENTION_ENABLED:'true',CHAT_RETENTION_MODE:'dry-run'}),
    {enabled:true,mode:'dry_run'});
  assert.throws(()=>chatRetentionRuntimeConfig({CHAT_RETENTION_MODE:'delete_everything'}),
    isType(/invalid chat retention mode/));
  const original=process.env.CHAT_RETENTION_MODE;
  delete process.env.CHAT_RETENTION_MODE;
  try{ assert.equal(chatRetentionRuntimeConfig().mode,'dry_run'); }
  finally{ if(original!==undefined) process.env.CHAT_RETENTION_MODE=original; }
});

test('evidence binding digests are scope-bound and reject malformed inputs',()=>{
  const base={kind:'backup',scope:SCOPE,sourceMaxMessageId:5,digest:DIGEST_A,
    throughAt:'2026-01-01T00:00:00.000Z',completedAt:'2026-01-02T00:00:00.000Z'};
  const digest=chatRetentionEvidenceBindingDigest(base);
  assert.match(digest,/^[a-f0-9]{64}$/);
  assert.notEqual(chatRetentionEvidenceBindingDigest({...base,kind:'export'}),digest);
  assert.notEqual(chatRetentionEvidenceBindingDigest({...base,scope:LOCAL_SCOPE}),digest);
  assert.throws(()=>chatRetentionEvidenceBindingDigest(),isType(/invalid retention evidence kind/));
  assert.throws(()=>chatRetentionEvidenceBindingDigest({...base,kind:'archive'}),isType(/evidence kind/));
  assert.throws(()=>chatRetentionEvidenceBindingDigest({...base,digest:undefined}),isType(/evidence digest/));
  assert.throws(()=>chatRetentionEvidenceBindingDigest({...base,digest:'A'.repeat(64)}),isType(/evidence digest/));
  assert.throws(()=>chatRetentionEvidenceBindingDigest({...base,sourceMaxMessageId:0}),isType(/source maximum/));
  assert.throws(()=>chatRetentionEvidenceBindingDigest({...base,sourceMaxMessageId:1.5}),isType(/source maximum/));
  assert.throws(()=>chatRetentionEvidenceBindingDigest({...base,throughAt:'2026-01-01'}),isType(/through time/));
  assert.throws(()=>chatRetentionEvidenceBindingDigest({...base,completedAt:Date.now()}),isType(/completion time/));
  for(const scopeValue of [null,[],'circle:1',
    {...SCOPE,scopeKey:''},{...SCOPE,scopeKey:'circle:2'},{...SCOPE,circleId:undefined},
    {...LOCAL_SCOPE,circleId:1},{...SCOPE,weekId:0},{...SCOPE,pairGroupId:-1},{...SCOPE,circleId:0}]){
    assert.throws(()=>chatRetentionEvidenceBindingDigest({...base,scope:scopeValue}),TypeError);
  }
});

test('scope registration statements require a cycle and token and bind only the tenant',async()=>{
  assert.throws(()=>chatRetentionScopeRegistrationStatement({scope:SCOPE,cycleId:'',generationToken:'t'}),
    isType(/scope registration/));
  assert.throws(()=>chatRetentionScopeRegistrationStatement({scope:SCOPE,cycleId:'2026-W01'}),
    isType(/scope registration/));
  assert.throws(()=>chatRetentionScopeRegistrationStatement({scope:{scopeKey:'circle:9',circleId:1},
    cycleId:'c',generationToken:'t'}),TypeError);
  const local=chatRetentionScopeRegistrationStatement({scope:{scopeKey:'local'},cycleId:'c',generationToken:'t'});
  assert.deepEqual(local.args,['local',null,'c','t']);
  await withFixture(async db=>{
    assert.equal(await chatRetentionScopeRegistrationAvailable(db),true);
    assert.equal(await chatRetentionScopeRegistrationAvailable({execute:async()=>({rows:[]})}),false);
    assert.equal(await chatRetentionScopeRegistrationAvailable({execute:async()=>({})}),false);
    await db.batch([
      `INSERT INTO pairing_weeks (id,week_label,week_start) VALUES (10,'2026-W01','2026-01-01')`,
      `INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
        (2,'a@example.test','hash','A','#111111'),(3,'b@example.test','hash','B','#222222')`,
      `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id) VALUES (20,10,2,3,NULL)`,
      `INSERT INTO pairing_week_runs (week_label,week_id,generation_token,algorithm_version,algorithm_seed,
        participant_count,participants_json) VALUES ('2026-W01',10,'gen-1','v1','seed',2,'[]')`,
    ],'write');
    const statement=chatRetentionScopeRegistrationStatement({scope:SCOPE,cycleId:'2026-W01',generationToken:'gen-1'});
    assert.equal((await db.execute(statement)).rowsAffected,1);
    const stale=chatRetentionScopeRegistrationStatement({scope:SCOPE,cycleId:'2026-W01',generationToken:'gen-0'});
    assert.equal((await db.execute(stale)).rowsAffected,0);
    const row=(await db.execute(`SELECT week_id,pair_group_id,scope_key,circle_id FROM chat_retention_scopes`)).rows[0];
    assert.deepEqual({...row},{week_id:10,pair_group_id:20,scope_key:'circle:1',circle_id:1});
  });
});

test('every entry point refuses clients that cannot guarantee transactions or batches',async()=>{
  const noTransaction={execute:async()=>({rows:[]})};
  await assert.rejects(()=>ensureChatRetentionReadiness(null),isType(/transactional database/));
  await assert.rejects(()=>ensureChatRetentionReadiness(noTransaction),isType(/transactional database/));
  await assert.rejects(()=>setChatRetentionControl({execute(){},transaction:'no'},{enabled:true,expectedGeneration:0}),
    isType(/transactional/));
  await assert.rejects(()=>claimChatRetentionRun({execute(){},transaction(){}},{workerId:'w',mode:'purge'}),
    isType(/atomic batch database client required/));
  await assert.rejects(()=>readChatRetentionMetrics(undefined),isType(/database client required/));
  await assert.rejects(()=>readChatRetentionMetrics({}),isType(/database client required/));
  await assert.rejects(()=>runChatRetentionWorker({db:{},enabled:false}),isType(/transactional/));
});

test('control, hold, heartbeat, replay and claim inputs are validated before touching the database',async()=>{
  const db={execute(){ throw new Error('must not run'); },transaction(){ throw new Error('must not run'); },
    batch(){ throw new Error('must not run'); }};
  await assert.rejects(()=>setChatRetentionControl(db,{enabled:'true',expectedGeneration:0}),isType(/retention control/));
  await assert.rejects(()=>setChatRetentionControl(db),isType(/retention control/));
  await assert.rejects(()=>setChatRetentionControl(db,{enabled:true,expectedGeneration:-1}),isType(/generation/));
  for(const hold of [null,[],{scopeKey:'circle:1',circleId:2,holdLevel:'tenant'},
    {scopeKey:'local',circleId:3,holdLevel:'tenant'},{scopeKey:'',holdLevel:'tenant'},
    {scopeKey:'circle:1',circleId:1,holdLevel:'room'},{scopeKey:'circle:1',circleId:1,holdLevel:'room',weekId:1},
    {scopeKey:'circle:1',circleId:1,holdLevel:'global',weekId:1,pairGroupId:1},
    {scopeKey:'circle:1',circleId:1}]){
    await assert.rejects(()=>placeChatRetentionHold(db,{hold,reason:'LEGAL'}),TypeError,JSON.stringify(hold));
    await assert.rejects(()=>releaseChatRetentionHold(db,{hold}),TypeError);
  }
  await assert.rejects(()=>placeChatRetentionHold(db,{hold:{scopeKey:'local',holdLevel:'tenant'},reason:'bad reason!'}),
    isType(/reason code/));
  await assert.rejects(()=>placeChatRetentionHold(db,{hold:{scopeKey:'local',holdLevel:'tenant'}}),isType(/reason code/));
  await assert.rejects(()=>placeChatRetentionHold(db),isType(/retention hold/));
  await assert.rejects(()=>releaseChatRetentionHold(db),isType(/retention hold/));
  await assert.rejects(()=>replayChatRetentionRun(db,{runId:1,reason:'BECAUSE'}),isType(/replay reason/));
  await assert.rejects(()=>replayChatRetentionRun(db,{runId:0,reason:'OPERATOR_RETRY'}),isType(/retention run/));
  await assert.rejects(()=>replayChatRetentionRun(db),isType(/retention run/));
  const heartbeat={runId:1,leaseToken:'t',workerId:'w',controlGeneration:1};
  await assert.rejects(()=>heartbeatChatRetentionLease(db,{...heartbeat,leaseToken:''}),isType(/lease token/));
  await assert.rejects(()=>heartbeatChatRetentionLease(db,{...heartbeat,leaseDurationMs:999}),isType(/retention lease/));
  await assert.rejects(()=>heartbeatChatRetentionLease(db,{...heartbeat,controlGeneration:0}),isType(/generation/));
  await assert.rejects(()=>heartbeatChatRetentionLease(db),isType(/retention run/));
  for(const workerId of ['',' ','x'.repeat(101),'worker\nnext','tab\u007f',undefined]){
    await assert.rejects(()=>claimChatRetentionRun(db,{workerId,mode:'purge'}),isType(/worker id/));
  }
  await assert.rejects(()=>claimChatRetentionRun(db,{workerId:'w',mode:undefined}),isType(/mode/));
  await assert.rejects(()=>claimChatRetentionRun(db,{workerId:'w',mode:'purge',leaseDurationMs:300_001}),
    isType(/retention lease/));
  await assert.rejects(()=>runChatRetentionWorker({db,enabled:true,workerId:'w',mode:'purge',maxBatches:0}),
    isType(/batch limit/));
  await assert.rejects(()=>runChatRetentionWorker({db,enabled:true,workerId:'w',mode:'purge',batchSize:101}),
    isType(/batch size/));
  assert.equal((await runChatRetentionWorker({db,enabled:'true',workerId:'w',mode:'purge'})).status,'disabled',
    'only the boolean true enables the worker');
  await assert.rejects(()=>enqueueNextChatRetentionRun(db,{mode:'purge',scope:SCOPE,maxFailures:21}),
    isType(/failure limit/));
  await assert.rejects(()=>enqueueNextChatRetentionRun(db),isType(/mode/));
});

test('batch processing rejects corrupt run snapshots without opening a transaction',async()=>{
  const db={execute(){ throw new Error('must not run'); },transaction(){ throw new Error('must not run'); }};
  const run={id:1,mode:'purge',...SCOPE,cutoffAt:'2026-01-01T00:00:00.000Z',sourceMaxMessageId:1,
    checkpoint:0,scanCursorId:0,failureCount:0,maxFailures:5,controlGeneration:1,leaseToken:'token'};
  for(const patch of [{leaseToken:''},{leaseToken:undefined},{mode:'erase'},{checkpoint:-1},{scanCursorId:-1},
    {sourceMaxMessageId:0},{controlGeneration:0},{id:0}]){
    await assert.rejects(()=>processChatRetentionBatch(db,{...run,...patch},{workerId:'w'}),
      isCode('RETENTION_RUN_CORRUPT'),JSON.stringify(patch));
  }
  await assert.rejects(()=>processChatRetentionBatch(db,{...run,scopeKey:'circle:7'},{workerId:'w'}),TypeError);
  await assert.rejects(()=>processChatRetentionBatch(db,undefined,{workerId:'w'}),TypeError);
  await assert.rejects(()=>processChatRetentionBatch(db,run,{workerId:'w',batchSize:0}),isType(/batch size/));
  await assert.rejects(()=>processChatRetentionBatch(db,run,{workerId:'w',leaseDurationMs:1}),isType(/lease/));
});

test('enqueue validates evidence shape before reading the clock or control row',async()=>{
  await withFixture(async db=>{
    const {request}=await seedRoom(db);
    await setChatRetentionControl(db,{enabled:true,expectedGeneration:0});
    const cases=[
      [{backup:null},/backup evidence/],
      [{backup:[]},/backup evidence/],
      [{exported:'digest'},/export evidence/],
      [{backup:{...request.backup,digest:undefined}},/backup evidence/],
      [{backup:{...request.backup,scopeBindingDigest:'short'}},/backup evidence/],
      [{exported:{...request.exported,scopeBindingDigest:undefined}},/export evidence/],
      [{exported:{...request.exported,sourceMaxMessageId:'x'}},/export source maximum/],
      [{backup:{...request.backup,throughAt:'yesterday'}},/backup through time/],
      [{exported:{...request.exported,completedAt:null}},/export completion time/],
    ];
    for(const [patch,pattern] of cases){
      await assert.rejects(()=>enqueueNextChatRetentionRun(db,{mode:'purge',...request,...patch}),isType(pattern));
    }
    await assert.rejects(()=>enqueueNextChatRetentionRun(db,{mode:'purge',...request,scope:null}),
      isType(/invalid retention scope/));
    assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM chat_retention_runs`)).rows[0].count),0);
  });
});

test('enqueue fails closed when retention is disabled, the clock is unreadable, or the run row is inconsistent',async()=>{
  await withFixture(async db=>{
    const {request}=await seedRoom(db);
    await assert.rejects(()=>enqueueNextChatRetentionRun(db,{mode:'purge',...request}),isCode('RETENTION_DISABLED'));
    await setChatRetentionControl(db,{enabled:true,expectedGeneration:0});
    await setChatRetentionControl(db,{enabled:false,expectedGeneration:1});
    await assert.rejects(()=>enqueueNextChatRetentionRun(db,{mode:'purge',...request}),isCode('RETENTION_DISABLED'));
    await setChatRetentionControl(db,{enabled:true,expectedGeneration:2});

    const noClock=faultDb(db,{tx:sql=>sql.includes('AS now_utc')?{rows:[{}]}:undefined});
    await assert.rejects(()=>enqueueNextChatRetentionRun(noClock,{mode:'purge',...request}),isType(/database time/));
    const noCutoff=faultDb(db,{tx:async(sql,next)=>{
      if(!sql.includes('AS now_utc')) return undefined;
      const result=await next();
      return {rows:[{now_utc:result.rows[0].now_utc}]};
    }});
    await assert.rejects(()=>enqueueNextChatRetentionRun(noCutoff,{mode:'purge',...request}),isType(/retention cutoff/));
    const emptyClock=faultDb(db,{tx:sql=>sql.includes('AS now_utc')?{}:undefined});
    await assert.rejects(()=>enqueueNextChatRetentionRun(emptyClock,{mode:'purge',...request}),isType(/database time/));

    const noControlRows=faultDb(db,{tx:sql=>sql.includes('SELECT enabled,generation FROM chat_retention_control')?{}:undefined});
    await assert.rejects(()=>enqueueNextChatRetentionRun(noControlRows,{mode:'purge',...request}),isCode('RETENTION_DISABLED'));

    const lostInsert=faultDb(db,{tx:sql=>sql.includes('INSERT INTO chat_retention_runs')?{}:undefined});
    await assert.rejects(()=>enqueueNextChatRetentionRun(lostInsert,{mode:'purge',...request}),isCode('RETENTION_RUN_INTEGRITY'));

    const foreignRun=faultDb(db,{tx:sql=>sql.includes('SELECT id,run_key,source_max_message_id,backup_evidence_digest,backup_through_at')
      ?{rows:[{id:9,run_key:'someone-else'}]}:undefined});
    await assert.rejects(()=>enqueueNextChatRetentionRun(foreignRun,{mode:'purge',...request}),isCode('RETENTION_EVIDENCE_CONFLICT'));

    const anchorRows=faultDb(db,{tx:sql=>sql.includes('SELECT COUNT(*) AS count FROM pair_messages')?{}:undefined});
    await assert.rejects(()=>enqueueNextChatRetentionRun(anchorRows,{mode:'purge',...request}),
      isCode('RETENTION_EVIDENCE_SOURCE_MISMATCH'));
    const noCandidateRows=faultDb(db,{tx:sql=>sql.includes('SELECT scope.scope_key,scope.circle_id')?{}:undefined});
    assert.equal((await enqueueNextChatRetentionRun(noCandidateRows,{mode:'purge',...request})).runId,null);
    const noExistingRows=faultDb(db,{tx:sql=>sql.includes('export_through_at,export_completed_at FROM chat_retention_runs')?{}:undefined});
    assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM chat_retention_runs`)).rows[0].count),0);

    // A concurrent writer that won the INSERT race: the row exists and matches,
    // so the caller reports created:false and writes no duplicate audit event.
    const raced=faultDb(db,{tx:async(sql,next)=>{
      if(!sql.includes('INSERT INTO chat_retention_runs')) return undefined;
      await next();
      return {rowsAffected:0};
    }});
    const result=await enqueueNextChatRetentionRun(raced,{mode:'purge',...request});
    assert.equal(result.created,false);
    assert.ok(result.runId>0);
    assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM chat_retention_audit_events
      WHERE action='enqueued'`)).rows[0].count),0);
    const again=await enqueueNextChatRetentionRun(noExistingRows,{mode:'purge',...request});
    assert.equal(again.created,false);
  });
});

test('enqueue rejects evidence completed in the future or exported after the backup',async()=>{
  await withFixture(async db=>{
    const {dbClock}=await seedRoom(db);
    await setChatRetentionControl(db,{enabled:true,expectedGeneration:0});
    const future=new Date(Date.parse(dbClock.now)+3_600_000).toISOString();
    const make=(backupPatch,exportPatch)=>{
      const base=evidenceFor(SCOPE,dbClock,1);
      const backup={...base.backup,...backupPatch};
      const exported={...base.exported,...exportPatch};
      backup.scopeBindingDigest=chatRetentionEvidenceBindingDigest({kind:'backup',scope:SCOPE,...backup});
      exported.scopeBindingDigest=chatRetentionEvidenceBindingDigest({kind:'export',scope:SCOPE,...exported});
      return {scope:SCOPE,backup,exported};
    };
    for(const request of [
      make({completedAt:future},{}),
      make({},{throughAt:new Date(Date.parse(dbClock.cutoff)-1).toISOString()}),
      make({throughAt:dbClock.backupCompleted,completedAt:dbClock.exportCompleted},{}),
      make({},{throughAt:dbClock.backupCompleted}),
    ]){
      await assert.rejects(()=>enqueueNextChatRetentionRun(db,{mode:'dry_run',...request}),
        isCode('RETENTION_EVIDENCE_ORDER_INVALID'));
    }
    const wrongExportBinding=evidenceFor(SCOPE,dbClock,1);
    wrongExportBinding.exported={...wrongExportBinding.exported,scopeBindingDigest:'c'.repeat(64)};
    await assert.rejects(()=>enqueueNextChatRetentionRun(db,{mode:'dry_run',...wrongExportBinding}),
      isCode('RETENTION_EVIDENCE_SCOPE_MISMATCH'));
  });
});

test('control generations are compare-and-set and a disabled first write is recorded as disabled',async()=>{
  await withFixture(async db=>{
    assert.deepEqual(await setChatRetentionControl(db,{enabled:false,expectedGeneration:0}),{enabled:false,generation:1});
    await assert.rejects(()=>setChatRetentionControl(db,{enabled:true,expectedGeneration:0}),isCode('RETENTION_CONTROL_STALE'));
    await assert.rejects(()=>setChatRetentionControl(db,{enabled:true,expectedGeneration:7}),isCode('RETENTION_CONTROL_STALE'));
    assert.deepEqual(await setChatRetentionControl(db,{enabled:true,expectedGeneration:1}),{enabled:true,generation:2});
    const silent=faultDb(db,{tx:sql=>sql.startsWith('UPDATE chat_retention_control')?{}:undefined});
    await assert.rejects(()=>setChatRetentionControl(silent,{enabled:false,expectedGeneration:2}),
      isCode('RETENTION_CONTROL_STALE'));
    const silentInsert=faultDb(db,{tx:sql=>sql.includes('INSERT INTO chat_retention_control')?{}:undefined});
    await assert.rejects(()=>setChatRetentionControl(silentInsert,{enabled:true,expectedGeneration:0}),
      isCode('RETENTION_CONTROL_STALE'));
    const control=(await db.execute(`SELECT enabled,generation FROM chat_retention_control`)).rows[0];
    assert.deepEqual([Number(control.enabled),Number(control.generation)],[1,2]);
  });
});

test('write transactions retry only lock conflicts, roll back, and never retry after commit starts',async()=>{
  await withFixture(async db=>{
    const lockErrors=[
      Object.assign(new Error('x'),{code:'SQLITE_BUSY'}),
      Object.assign(new Error('x'),{rawCode:'sqlite_locked'}),
      new Error('SQLITE_BUSY: database is locked'),
      new Error('database table is locked'),
      new Error('wrapped',{cause:Object.assign(new Error('inner'),{code:'TRANSACTION_CONFLICT'})}),
    ];
    for(const lockError of lockErrors){
      let calls=0;
      let rollbacks=0;
      const flaky=faultDb(db,{
        tx:sql=>{ if(sql.includes('INSERT INTO chat_retention_control')&&calls++===0) throw lockError; },
        rollback:real=>{ rollbacks+=1; return real.rollback(); },
      });
      await db.execute(`DELETE FROM chat_retention_control`);
      assert.deepEqual(await setChatRetentionControl(flaky,{enabled:true,expectedGeneration:0}),{enabled:true,generation:1});
      assert.equal(calls,2,lockError.message);
      assert.equal(rollbacks,1);
    }

    let attempts=0;
    const alwaysBusy=faultDb(db,{
      tx:sql=>{ if(sql.startsWith('UPDATE chat_retention_control')){ attempts+=1; throw Object.assign(new Error('busy'),{code:'SQLITE_BUSY'}); } },
      rollback:async real=>{ await real.rollback(); throw new Error('rollback also failed'); },
      close:real=>{ real.close(); throw new Error('close failed'); },
    });
    await assert.rejects(()=>setChatRetentionControl(alwaysBusy,{enabled:false,expectedGeneration:1}),
      error=>error.code==='SQLITE_BUSY');
    assert.equal(attempts,4);

    let commits=0;
    const commitFails=faultDb(db,{commit:()=>{ commits+=1; throw Object.assign(new Error('busy'),{code:'SQLITE_BUSY'}); }});
    await assert.rejects(()=>setChatRetentionControl(commitFails,{enabled:false,expectedGeneration:1}),
      error=>error.code==='SQLITE_BUSY');
    assert.equal(commits,1,'an ambiguous commit is never replayed');

    let plainAttempts=0;
    const notLock=faultDb(db,{tx:()=>{ plainAttempts+=1; throw new Error('constraint failed'); }});
    await assert.rejects(()=>setChatRetentionControl(notLock,{enabled:false,expectedGeneration:1}),/constraint failed/);
    assert.equal(plainAttempts,1);

    const deepCause=[1,2,3,4,5,6,7].reduce(cause=>new Error('wrap',{cause}),Object.assign(new Error('x'),{code:'SQLITE_BUSY'}));
    let deepAttempts=0;
    const deep=faultDb(db,{tx:()=>{ deepAttempts+=1; throw deepCause; }});
    await assert.rejects(()=>setChatRetentionControl(deep,{enabled:false,expectedGeneration:1}));
    assert.equal(deepAttempts,1,'cause chains deeper than six are not treated as lock conflicts');

    const failedOpen={execute:db.execute.bind(db),async transaction(){ throw new Error('cannot open'); }};
    await assert.rejects(()=>setChatRetentionControl(failedOpen,{enabled:false,expectedGeneration:1}),/cannot open/);
  });
});

test('claims retry lock conflicts and treat inconsistent batch results as integrity failures',async()=>{
  await withFixture(async db=>{
    await enqueued(db);
    let busy=0;
    const flaky=faultDb(db,{batch:(statements,modeValue,next)=>{
      if(busy++===0) throw Object.assign(new Error('busy'),{code:'LIBSQL_TRANSACTION_BUSY'});
      return next();
    }});
    const claimed=await claimChatRetentionRun(flaky,{workerId:'w1',mode:'purge'});
    assert.equal(claimed.circleId,1);
    assert.equal(busy,2);

    await assert.rejects(()=>claimChatRetentionRun(faultDb(db,{batch:()=>{ throw Object.assign(new Error('x'),{code:'SQLITE_BUSY_SNAPSHOT'}); }}),
      {workerId:'w2',mode:'purge'}),error=>error.code==='SQLITE_BUSY_SNAPSHOT');
    await assert.rejects(()=>claimChatRetentionRun(faultDb(db,{batch:async()=>[{rowsAffected:2},{rowsAffected:2}]}),
      {workerId:'w2',mode:'purge'}),isCode('RETENTION_CLAIM_INTEGRITY'));
    await assert.rejects(()=>claimChatRetentionRun(faultDb(db,{batch:async()=>[{rowsAffected:1},{}]}),
      {workerId:'w2',mode:'purge'}),isCode('RETENTION_CLAIM_INTEGRITY'));
    assert.equal(await claimChatRetentionRun(faultDb(db,{batch:async()=>undefined}),{workerId:'w2',mode:'purge'}),null);
    assert.equal(await claimChatRetentionRun(faultDb(db,{batch:async()=>[{}]}),{workerId:'w2',mode:'purge'}),null);
    await assert.rejects(()=>claimChatRetentionRun(faultDb(db,{batch:()=>{ throw new Error('network'); }}),
      {workerId:'w2',mode:'purge'}),/network/);
    // Nothing else is claimable while the first lease is live.
    assert.equal(await claimChatRetentionRun(db,{workerId:'w2',mode:'purge'}),null);
  });
});

test('a claim whose row disappears before readback returns no run',async()=>{
  await withFixture(async db=>{
    await enqueued(db);
    const vanished=faultDb(db,{execute:sql=>sql.includes('FROM chat_retention_runs WHERE lease_owner=?')?{}:undefined});
    assert.equal(await claimChatRetentionRun(vanished,{workerId:'w',mode:'purge'}),null);
  });
});

test('local-runtime runs carry a null circle through claim, processing and completion',async()=>{
  await withFixture(async db=>{
    await enqueued(db,{scopeValue:LOCAL_SCOPE,mode:'dry_run'});
    const run=await claimChatRetentionRun(db,{workerId:'local-worker',mode:'dry_run'});
    assert.equal(run.circleId,null);
    assert.equal(run.scopeKey,'local');
    const batch=await processChatRetentionBatch(db,run,{workerId:'local-worker'});
    assert.deepEqual({status:batch.status,count:batch.count},{status:'processing',count:1});
    assert.equal((await processChatRetentionBatch(db,run,{workerId:'local-worker'})).status,'completed');
    assert.equal(await messageCount(db),1,'dry run never deletes');
  });
});

test('processing fences on a disabled or regenerated control and on a removed scope mapping',async()=>{
  await withFixture(async db=>{
    await enqueued(db);
    const run=await claimChatRetentionRun(db,{workerId:'w',mode:'purge'});
    await db.execute(`UPDATE chat_retention_control SET enabled=0`);
    assert.deepEqual(await processChatRetentionBatch(db,run,{workerId:'w'}),{leaseLost:true,status:'fenced',count:0});
    await db.execute(`UPDATE chat_retention_control SET enabled=1,generation=generation+1`);
    assert.deepEqual(await processChatRetentionBatch(db,run,{workerId:'w'}),{leaseLost:true,status:'fenced',count:0});
    assert.equal(await heartbeatChatRetentionLease(db,{runId:run.id,leaseToken:run.leaseToken,workerId:'w',
      controlGeneration:run.controlGeneration}),false);
    await db.execute(`UPDATE chat_retention_control SET generation=generation-1`);
    assert.equal(await heartbeatChatRetentionLease(db,{runId:run.id,leaseToken:run.leaseToken,workerId:'w',
      controlGeneration:run.controlGeneration}),true);
    const remapped=faultDb(db,{tx:async(sql,next)=>{
      if(!sql.includes('AS live_scope_key')) return undefined;
      const result=await next();
      return {rows:result.rows.map(row=>({...row,live_scope_key:null}))};
    }});
    await assert.rejects(()=>processChatRetentionBatch(remapped,run,{workerId:'w'}),isCode('RETENTION_SCOPE_CHANGED'));
    assert.equal(await messageCount(db),1);
  });
});

test('a tampered run key is a non-retryable evidence conflict that dead-letters without deleting',async()=>{
  await withFixture(async db=>{
    await enqueued(db);
    await db.execute(`UPDATE chat_retention_runs SET run_key='${'f'.repeat(64)}'`);
    const result=await runChatRetentionWorker({db,workerId:'w',enabled:true,mode:'purge'});
    assert.equal(result.status,'dead_letter');
    const row=await runRow(db);
    assert.deepEqual([row.status,row.last_error_code,Number(row.failure_count)],
      ['dead_letter','RETENTION_EVIDENCE_CONFLICT',1]);
    assert.equal(await messageCount(db),1);
    assert.equal(await replayChatRetentionRun(db,{runId:999,reason:'OPERATOR_RETRY'}),false);
    const silent=faultDb(db,{tx:sql=>sql.includes('replay_count=replay_count+1')?{}:undefined});
    assert.equal(await replayChatRetentionRun(silent,{runId:1,reason:'OPERATOR_RETRY'}),false);
    assert.equal((await runRow(db)).status,'dead_letter');
  });
});

test('worker reports idle without a claimable run and fenced when completion loses the control race',async()=>{
  await withFixture(async db=>{
    await setChatRetentionControl(db,{enabled:true,expectedGeneration:0});
    const idle=await runChatRetentionWorker({db,workerId:'w',enabled:true,mode:'purge'});
    assert.deepEqual({...idle,durationMs:0},{disabled:false,claimed:0,batches:0,eligible:0,deleted:0,status:'idle',durationMs:0});
  });
  await withFixture(async db=>{
    await enqueued(db);
    const fenced=faultDb(db,{tx:sql=>sql.includes("SET status='completed'")?{}:undefined});
    const result=await runChatRetentionWorker({db:fenced,workerId:'w',enabled:true,mode:'purge'});
    assert.deepEqual({status:result.status,batches:result.batches,deleted:result.deleted},
      {status:'fenced',batches:1,deleted:1});
    assert.equal((await runRow(db)).status,'processing');
  });
});

test('missing hold and batch rows are treated as empty without skipping safety checks',async()=>{
  await withFixture(async db=>{
    await enqueued(db,{messages:2});
    const sparse=faultDb(db,{tx:sql=>{
      if(sql.includes('AS held FROM')) return {rows:[]};
      if(sql.startsWith('SELECT id FROM pair_messages')) return {};
      return undefined;
    }});
    const result=await runChatRetentionWorker({db:sparse,workerId:'w',enabled:true,mode:'purge'});
    assert.equal(result.status,'completed');
    assert.equal(result.deleted,0);
    assert.equal(await messageCount(db),2);
  });
});

test('a partial purge delete or a lost checkpoint update dead-letters and rolls the delete back',async()=>{
  for(const [hook,code] of [
    [sql=>sql.startsWith('DELETE FROM pair_messages')?{rowsAffected:0}:undefined,'RETENTION_DELETE_FENCED'],
    [sql=>sql.includes('SET checkpoint=checkpoint+1')?{}:undefined,'RETENTION_LEASE_LOST'],
  ]){
    await withFixture(async db=>{
      await enqueued(db,{messages:2});
      const result=await runChatRetentionWorker({db:faultDb(db,{tx:hook}),workerId:'w',enabled:true,mode:'purge'});
      assert.equal(result.status,'dead_letter');
      assert.equal((await runRow(db)).last_error_code,code);
      assert.equal(await messageCount(db),2,'the failed batch transaction is rolled back');
    });
  }
});

test('worker reports lease loss when yielding or recording a failure finds the lease gone',async()=>{
  await withFixture(async db=>{
    await enqueued(db,{messages:3});
    const noYield=faultDb(db,{tx:sql=>sql.includes("SET status='pending',control_generation=NULL")?{}:undefined});
    const result=await runChatRetentionWorker({db:noYield,workerId:'w',enabled:true,mode:'purge',batchSize:1,maxBatches:1});
    assert.deepEqual({status:result.status,deleted:result.deleted},{status:'lease_lost',deleted:1});
  });
  for(const failureHook of [
    sql=>sql.includes('SELECT run.failure_count')?{}:undefined,
    sql=>sql.includes('SET status=?,failure_count=?')?{}:undefined,
  ]){
    await withFixture(async db=>{
      await enqueued(db);
      const broken=faultDb(db,{tx:sql=>{
        if(sql.includes('julianday(created_at) IS NULL')) throw new Error('raw failure with private-1');
        return failureHook(sql);
      }});
      const result=await runChatRetentionWorker({db:broken,workerId:'w',enabled:true,mode:'purge'});
      assert.equal(result.status,'lease_lost');
      assert.equal((await runRow(db)).status,'processing');
      assert.equal(await messageCount(db),1);
    });
  }
});

test('scope adoption fails closed for missing groups, non-primary circles and ambiguous local ownership',async()=>{
  await withFixture(async db=>{
    await assert.rejects(()=>adoptChatRetentionScope(db,{scope:SCOPE}),isCode('RETENTION_SCOPE_AMBIGUOUS'));
    await assert.rejects(()=>adoptChatRetentionScope(db),isType(/invalid retention scope/));
    await db.batch([
      `INSERT INTO circles (id,public_id,slug,name,is_primary) VALUES (1,'public-one','one','One',0)`,
      `INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
        (2,'a@example.test','hash','A','#111111'),(3,'b@example.test','hash','B','#222222')`,
      `INSERT INTO pairing_weeks (id,week_label,week_start) VALUES (10,'2026-W01','2026-01-01')`,
      `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id) VALUES (20,10,2,3,NULL)`,
    ],'write');
    await assert.rejects(()=>adoptChatRetentionScope(db,{scope:SCOPE}),isCode('RETENTION_SCOPE_AMBIGUOUS'));
    const noCandidateRows=faultDb(db,{tx:sql=>sql.startsWith('WITH participants')?{}:undefined});
    await assert.rejects(()=>adoptChatRetentionScope(noCandidateRows,{scope:SCOPE}),isCode('RETENTION_SCOPE_AMBIGUOUS'));
    const noGroupRows=faultDb(db,{tx:sql=>sql.includes('SELECT user_a_id,user_b_id,user_c_id')?{}:undefined});
    await assert.rejects(()=>adoptChatRetentionScope(noGroupRows,{scope:SCOPE}),isCode('RETENTION_SCOPE_AMBIGUOUS'));

    await assert.rejects(()=>adoptChatRetentionScope(db,{scope:LOCAL_SCOPE}),isCode('RETENTION_SCOPE_AMBIGUOUS'));
    await db.execute(`UPDATE circles SET is_primary=1`);
    await assert.rejects(()=>adoptChatRetentionScope(db,{scope:LOCAL_SCOPE,localRuntime:true}),
      isCode('RETENTION_SCOPE_AMBIGUOUS'));
    await db.execute(`UPDATE circles SET archived_at='2026-01-01'`);
    const noPrimaryRows=faultDb(db,{tx:sql=>sql.includes('WHERE is_primary=1 AND archived_at IS NULL')?{}:undefined});
    assert.deepEqual(await adoptChatRetentionScope(noPrimaryRows,{scope:LOCAL_SCOPE,localRuntime:true}),{created:true});
    assert.deepEqual(await adoptChatRetentionScope(db,{scope:LOCAL_SCOPE,localRuntime:true}),{created:false});
    await assert.rejects(()=>adoptChatRetentionScope(db,{scope:SCOPE}),isCode('RETENTION_SCOPE_CONFLICT'));
  });
});

test('holds require a known scope and releasing an inactive hold is a no-op',async()=>{
  await withFixture(async db=>{
    const room={scopeKey:'circle:1',circleId:1,holdLevel:'room',weekId:10,pairGroupId:20};
    await assert.rejects(()=>placeChatRetentionHold(db,{hold:room,reason:'LEGAL'}),isCode('RETENTION_SCOPE_UNKNOWN'));
    await assert.rejects(()=>placeChatRetentionHold(db,{hold:{scopeKey:'local',holdLevel:'tenant'},reason:'LEGAL'}),
      isCode('RETENTION_SCOPE_UNKNOWN'));
    const noRows=faultDb(db,{tx:sql=>sql.includes('SELECT COUNT(*) AS count FROM chat_retention_scopes')?{}:undefined});
    await assert.rejects(()=>placeChatRetentionHold(noRows,{hold:room,reason:'LEGAL'}),isCode('RETENTION_SCOPE_UNKNOWN'));
    assert.deepEqual(await releaseChatRetentionHold(db,{hold:room}),{released:false});
    await seedRoom(db);
    assert.deepEqual(await placeChatRetentionHold(db,{hold:room,reason:'legal_request'}),{active:true});
    const hold=(await db.execute(`SELECT status,reason_code,hold_level FROM chat_retention_legal_holds`)).rows[0];
    assert.deepEqual({...hold},{status:'active',reason_code:'LEGAL_REQUEST',hold_level:'room'});
    const silent=faultDb(db,{tx:sql=>sql.startsWith('UPDATE chat_retention_legal_holds')?{}:undefined});
    assert.deepEqual(await releaseChatRetentionHold(silent,{hold:room}),{released:false});
    assert.deepEqual(await releaseChatRetentionHold(db,{hold:room}),{released:true});
    assert.deepEqual(await releaseChatRetentionHold(db,{hold:room}),{released:false});
  });
});

test('metrics tolerate missing result rows and report defaults',async()=>{
  const empty={execute:async()=>({})};
  const metrics=await readChatRetentionMetrics(empty);
  assert.deepEqual(metrics.runs,[]);
  assert.deepEqual(metrics.holds,[]);
  assert.equal(metrics.control.present,false);
  assert.deepEqual(metrics.anomalies,{
    unmappedCount:0,unmappedCountCapped:false,invalidTimestampCount:0,invalidTimestampCountCapped:false,
    futureTimestampCount:0,futureTimestampCountCapped:false,
  });
  const capped={execute:async sql=>sql.includes('unmapped_count')
    ?{rows:[{unmapped_count:1001,invalid_timestamp_count:1001,future_timestamp_count:1001}]}
    :sql.includes('GROUP BY mode,status')?{rows:[{mode:'purge',status:'completed',count:1}]}:{rows:[]}};
  const cappedMetrics=await readChatRetentionMetrics(capped);
  assert.equal(cappedMetrics.anomalies.unmappedCountCapped,true);
  assert.equal(cappedMetrics.anomalies.futureTimestampCountCapped,true);
  assert.deepEqual(cappedMetrics.runs,[{mode:'purge',status:'completed',count:1,eligibleCount:0,deletedCount:0,
    oldestCreatedAt:''}]);
});
