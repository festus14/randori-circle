import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  adoptChatRetentionScope,
  CHAT_RETENTION_POLICY,
  ChatRetentionError,
  chatRetentionEvidenceScopeDigest,
  claimChatRetentionRun,
  enqueueNextChatRetentionRun,
  heartbeatChatRetentionLease,
  placeChatRetentionHold,
  processChatRetentionBatch,
  readChatRetentionMetrics,
  releaseChatRetentionHold,
  replayChatRetentionRun,
  runChatRetentionWorker,
  setChatRetentionControl,
} from '../../api/_chat-retention.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';
import { MAX_MESSAGES_PER_ROOM } from '../../api/_messages.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const DIGEST_A='a'.repeat(64);
const DIGEST_B='b'.repeat(64);
const DEFAULT_SCOPE=Object.freeze({scopeKey:'circle:1',circleId:1,weekId:10,pairGroupId:20});

async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-chat-retention-'));
  const path=join(directory,'test.sqlite');
  const db=createClient({url:`file:${path}`});
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY});
  return {
    db,path,
    second(){ return createClient({url:`file:${path}`}); },
    close(){ db.close(); rmSync(directory,{recursive:true,force:true}); },
  };
}

async function clock(db){
  const result=await db.execute(`SELECT
    strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc,
    strftime('%Y-%m-%dT00:00:00.000Z','now','-90 days') AS cutoff_utc,
    strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes') AS export_completed,
    strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute') AS backup_completed`);
  const row=result.rows[0];
  return {
    now:String(row.now_utc),cutoff:String(row.cutoff_utc),
    backup:{digest:DIGEST_A,throughAt:String(row.cutoff_utc),completedAt:String(row.backup_completed)},
    exported:{digest:DIGEST_B,throughAt:String(row.cutoff_utc),completedAt:String(row.export_completed)},
  };
}

async function mapRoom(db,{scopeKey='circle:1',circleId=1,weekId=10,pairGroupId=20}={}){
  await db.execute({
    sql:`INSERT INTO chat_retention_scopes
      (week_id,pair_group_id,scope_key,circle_id) VALUES (?,?,?,?)`,
    args:[weekId,pairGroupId,scopeKey,circleId],
  });
}

async function message(db,{id,weekId=10,pairGroupId=20,senderId=2,createdAt,text='private-body'}={}){
  await db.execute({
    sql:`INSERT INTO pair_messages
      (id,week_id,pair_group_id,sender_id,message,created_at) VALUES (?,?,?,?,?,?)`,
    args:[id,weekId,pairGroupId,senderId,text,createdAt],
  });
}

function offsetInstant(epochMs,offsetHours=-3){
  const shifted=new Date(epochMs+offsetHours*60*60*1000).toISOString().slice(0,23);
  return `${shifted}${offsetHours<0?'-':'+'}${String(Math.abs(offsetHours)).padStart(2,'0')}:00`;
}

async function enable(db){
  return setChatRetentionControl(db,{enabled:true,expectedGeneration:0});
}

async function retentionRequest(db,dbClock,requestedScope=DEFAULT_SCOPE){
  const result=await db.execute({
    sql:`SELECT MAX(id) AS source_max_message_id FROM pair_messages
      WHERE week_id=? AND pair_group_id=?`,
    args:[requestedScope.weekId,requestedScope.pairGroupId],
  });
  const sourceMaxMessageId=Number(result.rows?.[0]?.source_max_message_id||0);
  assert.ok(sourceMaxMessageId>0,'evidence fixture requires a non-empty exact room');
  const scopeBindingDigest=chatRetentionEvidenceScopeDigest(requestedScope,sourceMaxMessageId);
  return {
    scope:requestedScope,
    backup:{...dbClock.backup,sourceMaxMessageId,scopeBindingDigest},
    exported:{...dbClock.exported,sourceMaxMessageId,scopeBindingDigest},
  };
}

test('the 90-day database cutoff is strict across canonical, legacy, and offset timestamps',async()=>{
  const item=await fixture();
  try{
    const dbClock=await clock(item.db);
    const cutoffMs=Date.parse(dbClock.cutoff);
    await mapRoom(item.db);
    await message(item.db,{id:1,createdAt:new Date(cutoffMs-1).toISOString(),text:'before'});
    await message(item.db,{id:2,createdAt:dbClock.cutoff,text:'exact'});
    await message(item.db,{id:3,createdAt:new Date(cutoffMs-1000).toISOString().replace('T',' ').slice(0,19),text:'legacy'});
    await message(item.db,{id:4,createdAt:offsetInstant(cutoffMs-2000),text:'offset-before'});
    await message(item.db,{id:5,createdAt:offsetInstant(cutoffMs),text:'offset-exact'});
    await enable(item.db);
    const queued=await enqueueNextChatRetentionRun(item.db,{
      mode:'purge',...await retentionRequest(item.db,dbClock),
    });
    assert.equal(queued.cutoffAt,dbClock.cutoff);
    const result=await runChatRetentionWorker({
      db:item.db,workerId:'boundary-worker',enabled:true,mode:'purge',batchSize:100,maxBatches:2,
    });
    assert.equal(result.status,'completed');
    assert.equal(result.deleted,3);
    const remaining=await item.db.execute(`SELECT id,message FROM pair_messages ORDER BY id`);
    assert.deepEqual(remaining.rows.map(row=>[Number(row.id),row.message]),[
      [2,'exact'],[5,'offset-exact'],
    ]);
    assert.equal(MAX_MESSAGES_PER_ROOM,10_000);
  }finally{ item.close(); }
});

test('bounded batches checkpoint and resume after an expired lease without skips or double counts',async()=>{
  const item=await fixture();
  const second=item.second();
  try{
    const dbClock=await clock(item.db);
    await mapRoom(item.db);
    for(let id=1;id<=5;id+=1){
      await message(item.db,{id,createdAt:new Date(Date.parse(dbClock.cutoff)-id*1000).toISOString()});
    }
    await enable(item.db);
    await enqueueNextChatRetentionRun(item.db,{
      mode:'purge',...await retentionRequest(item.db,dbClock),
    });
    const first=await claimChatRetentionRun(item.db,{workerId:'worker-a',mode:'purge',leaseDurationMs:1000});
    const firstBatch=await processChatRetentionBatch(item.db,first,{
      workerId:'worker-a',batchSize:2,leaseDurationMs:1000,
    });
    assert.equal(firstBatch.count,2);
    await item.db.execute(`UPDATE chat_retention_runs SET leased_until='2000-01-01T00:00:00.000Z'`);
    const reclaimed=await claimChatRetentionRun(second,{workerId:'worker-b',mode:'purge',leaseDurationMs:1000});
    assert.equal(reclaimed.id,first.id);
    assert.notEqual(reclaimed.leaseToken,first.leaseToken);
    assert.equal(await heartbeatChatRetentionLease(item.db,{
      runId:first.id,leaseToken:first.leaseToken,workerId:'worker-a',
      controlGeneration:first.controlGeneration,leaseDurationMs:1000,
    }),false);
    const secondBatch=await processChatRetentionBatch(second,reclaimed,{
      workerId:'worker-b',batchSize:2,leaseDurationMs:1000,
    });
    assert.equal(secondBatch.count,2);
    const thirdBatch=await processChatRetentionBatch(second,reclaimed,{
      workerId:'worker-b',batchSize:2,leaseDurationMs:1000,
    });
    assert.equal(thirdBatch.count,1);
    const completed=await processChatRetentionBatch(second,reclaimed,{
      workerId:'worker-b',batchSize:2,leaseDurationMs:1000,
    });
    assert.equal(completed.status,'completed');
    const run=(await item.db.execute(`SELECT checkpoint,eligible_count,deleted_count,status
      FROM chat_retention_runs`)).rows[0];
    assert.deepEqual({
      checkpoint:Number(run.checkpoint),eligible:Number(run.eligible_count),
      deleted:Number(run.deleted_count),status:String(run.status),
    },{checkpoint:3,eligible:5,deleted:5,status:'completed'});
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM pair_messages`)).rows[0].count),0);
  }finally{ second.close(); item.close(); }
});

test('an evidence-gated run never deletes old-dated messages written after its source snapshot',async()=>{
  const item=await fixture();
  try{
    const dbClock=await clock(item.db);
    await mapRoom(item.db);
    await message(item.db,{id:1,createdAt:new Date(Date.parse(dbClock.cutoff)-2000).toISOString(),
      text:'covered-by-evidence'});
    const evidenceBoundRequest=await retentionRequest(item.db,dbClock);
    await enable(item.db);
    await message(item.db,{id:2,createdAt:new Date(Date.parse(dbClock.cutoff)-1000).toISOString(),
      text:'requires-new-evidence'});
    await enqueueNextChatRetentionRun(item.db,{mode:'purge',...evidenceBoundRequest});

    const result=await runChatRetentionWorker({
      db:item.db,workerId:'snapshot-worker',enabled:true,mode:'purge',batchSize:100,maxBatches:2,
    });
    assert.equal(result.status,'completed');
    assert.equal(result.deleted,1);
    const remaining=await item.db.execute(`SELECT id,message FROM pair_messages ORDER BY id`);
    assert.deepEqual(remaining.rows.map(row=>[Number(row.id),String(row.message)]),[
      [2,'requires-new-evidence'],
    ]);
    const run=(await item.db.execute(`SELECT source_max_message_id,eligible_count,deleted_count
      FROM chat_retention_runs`)).rows[0];
    assert.deepEqual([Number(run.source_max_message_id),Number(run.eligible_count),Number(run.deleted_count)],
      [1,1,1]);
  }finally{ item.close(); }
});

test('concurrent workers have exclusive leases and generation fencing defeats disable-enable ABA',async()=>{
  const item=await fixture();
  const second=item.second();
  try{
    const dbClock=await clock(item.db);
    await mapRoom(item.db);
    await message(item.db,{id:1,createdAt:new Date(Date.parse(dbClock.cutoff)-1000).toISOString()});
    await enable(item.db);
    await enqueueNextChatRetentionRun(item.db,{
      mode:'purge',...await retentionRequest(item.db,dbClock),
    });
    const [left,right]=await Promise.all([
      claimChatRetentionRun(item.db,{workerId:'worker-a',mode:'purge'}),
      claimChatRetentionRun(second,{workerId:'worker-b',mode:'purge'}),
    ]);
    assert.equal([left,right].filter(Boolean).length,1);
    const claimed=left||right;
    const claimedOwner=left?'worker-a':'worker-b';
    const disabled=await setChatRetentionControl(item.db,{enabled:false,expectedGeneration:1});
    assert.equal(disabled.generation,2);
    const released=(await item.db.execute(`SELECT status,lease_owner,control_generation
      FROM chat_retention_runs`)).rows[0];
    assert.deepEqual(released,{status:'pending',lease_owner:null,control_generation:null});
    await setChatRetentionControl(item.db,{enabled:true,expectedGeneration:2});
    const stale=await processChatRetentionBatch(item.db,claimed,{workerId:claimedOwner,batchSize:1});
    assert.equal(stale.status,'lease_lost');
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM pair_messages`)).rows[0].count),1);
    const replacement=await claimChatRetentionRun(item.db,{workerId:'worker-c',mode:'purge'});
    assert.ok(replacement);
    assert.equal(replacement.controlGeneration,3);
    assert.notEqual(replacement.leaseToken,claimed.leaseToken);
  }finally{ second.close(); item.close(); }
});

test('tenant and room holds preserve content and release requeues held work',async()=>{
  const item=await fixture();
  try{
    const dbClock=await clock(item.db);
    await mapRoom(item.db,{scopeKey:'circle:1',circleId:1,weekId:10,pairGroupId:20});
    await mapRoom(item.db,{scopeKey:'circle:2',circleId:2,weekId:11,pairGroupId:21});
    await message(item.db,{id:1,weekId:10,pairGroupId:20,createdAt:new Date(Date.parse(dbClock.cutoff)-2000).toISOString(),text:'held-tenant'});
    await message(item.db,{id:2,weekId:11,pairGroupId:21,createdAt:new Date(Date.parse(dbClock.cutoff)-1000).toISOString(),text:'other-tenant'});
    await enable(item.db);
    await placeChatRetentionHold(item.db,{
      hold:{scopeKey:'circle:1',circleId:1,holdLevel:'tenant'},reason:'LEGAL_REQUEST',
    });
    const otherScope={scopeKey:'circle:2',circleId:2,weekId:11,pairGroupId:21};
    await enqueueNextChatRetentionRun(item.db,{
      mode:'purge',...await retentionRequest(item.db,dbClock,otherScope),
    });
    await runChatRetentionWorker({db:item.db,workerId:'isolation-worker',enabled:true,mode:'purge'});
    assert.deepEqual((await item.db.execute(`SELECT id FROM pair_messages ORDER BY id`)).rows.map(row=>Number(row.id)),[1]);

    await releaseChatRetentionHold(item.db,{
      hold:{scopeKey:'circle:1',circleId:1,holdLevel:'tenant'},
    });
    await enqueueNextChatRetentionRun(item.db,{
      mode:'purge',...await retentionRequest(item.db,dbClock),
    });
    const claimed=await claimChatRetentionRun(item.db,{workerId:'hold-race',mode:'purge'});
    await placeChatRetentionHold(item.db,{
      hold:{scopeKey:'circle:1',circleId:1,holdLevel:'room',weekId:10,pairGroupId:20},
      reason:'EXPORT_PENDING',
    });
    const blocked=await processChatRetentionBatch(item.db,claimed,{workerId:'hold-race'});
    assert.equal(blocked.leaseLost,true);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM pair_messages`)).rows[0].count),1);
    const run=(await item.db.execute(`SELECT status,last_error_code FROM chat_retention_runs
      WHERE week_id=10 AND pair_group_id=20`)).rows[0];
    assert.deepEqual(run,{status:'held',last_error_code:'LEGAL_HOLD_ACTIVE'});
  }finally{ item.close(); }
});

test('backup and export evidence must cover the cutoff and complete export before backup',async()=>{
  const item=await fixture();
  try{
    const dbClock=await clock(item.db);
    await mapRoom(item.db);
    await message(item.db,{id:1,createdAt:new Date(Date.parse(dbClock.cutoff)-1000).toISOString()});
    await enable(item.db);
    const request=await retentionRequest(item.db,dbClock);
    await assert.rejects(()=>enqueueNextChatRetentionRun(item.db,{
      mode:'purge',...request,
      exported:{...request.exported,completedAt:dbClock.now},
    }),error=>error instanceof ChatRetentionError&&error.code==='RETENTION_EVIDENCE_ORDER_INVALID');
    await assert.rejects(()=>enqueueNextChatRetentionRun(item.db,{
      mode:'purge',...request,
      backup:{...request.backup,throughAt:new Date(Date.parse(dbClock.cutoff)-1).toISOString()},
    }),error=>error instanceof ChatRetentionError&&error.code==='RETENTION_EVIDENCE_ORDER_INVALID');
    await assert.rejects(()=>enqueueNextChatRetentionRun(item.db,{
      mode:'purge',...request,
      backup:{...request.backup,sourceMaxMessageId:2},
    }),error=>error instanceof ChatRetentionError&&error.code==='RETENTION_EVIDENCE_SOURCE_MISMATCH');
    const missingBinding=chatRetentionEvidenceScopeDigest(DEFAULT_SCOPE,999);
    await assert.rejects(()=>enqueueNextChatRetentionRun(item.db,{
      mode:'purge',...request,
      backup:{...request.backup,sourceMaxMessageId:999,scopeBindingDigest:missingBinding},
      exported:{...request.exported,sourceMaxMessageId:999,scopeBindingDigest:missingBinding},
    }),error=>error instanceof ChatRetentionError&&error.code==='RETENTION_EVIDENCE_SOURCE_MISMATCH');
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM chat_retention_runs`)).rows[0].count),0);
  }finally{ item.close(); }
});

test('room-bound evidence cannot authorize a different tenant with eligible content',async()=>{
  const item=await fixture();
  try{
    const dbClock=await clock(item.db);
    const firstScope={scopeKey:'circle:1',circleId:1,weekId:10,pairGroupId:20};
    const secondScope={scopeKey:'circle:2',circleId:2,weekId:11,pairGroupId:21};
    await mapRoom(item.db,firstScope);
    await mapRoom(item.db,secondScope);
    await message(item.db,{id:1,weekId:10,pairGroupId:20,
      createdAt:new Date(Date.parse(dbClock.cutoff)-2000).toISOString()});
    await message(item.db,{id:2,weekId:11,pairGroupId:21,
      createdAt:new Date(Date.parse(dbClock.cutoff)-1000).toISOString()});
    const firstEvidence=await retentionRequest(item.db,dbClock,firstScope);
    await enable(item.db);

    await assert.rejects(()=>enqueueNextChatRetentionRun(item.db,{
      mode:'purge',scope:secondScope,
      backup:firstEvidence.backup,exported:firstEvidence.exported,
    }),error=>error instanceof ChatRetentionError
      &&error.code==='RETENTION_EVIDENCE_SCOPE_MISMATCH');
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count
      FROM chat_retention_runs`)).rows[0].count),0);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count
      FROM pair_messages`)).rows[0].count),2);
  }finally{ item.close(); }
});

test('dry runs are bounded and leave message rows byte-for-byte unchanged',async()=>{
  const item=await fixture();
  try{
    const dbClock=await clock(item.db);
    await mapRoom(item.db);
    for(let id=1;id<=3;id+=1){
      await message(item.db,{id,createdAt:new Date(Date.parse(dbClock.cutoff)-id).toISOString(),text:`body-${id}`});
    }
    const before=(await item.db.execute(`SELECT * FROM pair_messages ORDER BY id`)).rows;
    await enable(item.db);
    await enqueueNextChatRetentionRun(item.db,{
      mode:'dry_run',...await retentionRequest(item.db,dbClock),
    });
    const first=await runChatRetentionWorker({
      db:item.db,workerId:'dry-worker',enabled:true,mode:'dry_run',batchSize:2,maxBatches:1,
    });
    assert.deepEqual({status:first.status,eligible:first.eligible,deleted:first.deleted},
      {status:'pending',eligible:2,deleted:0});
    const second=await runChatRetentionWorker({
      db:item.db,workerId:'dry-worker',enabled:true,mode:'dry_run',batchSize:2,maxBatches:2,
    });
    assert.equal(second.status,'completed');
    assert.deepEqual((await item.db.execute(`SELECT * FROM pair_messages ORDER BY id`)).rows,before);
    const run=(await item.db.execute(`SELECT checkpoint,eligible_count,deleted_count,status
      FROM chat_retention_runs`)).rows[0];
    assert.deepEqual([Number(run.checkpoint),Number(run.eligible_count),Number(run.deleted_count),run.status],
      [2,3,0,'completed']);
  }finally{ item.close(); }
});

test('invalid and future timestamps are preserved with fixed-code dead-letter visibility and replay',async()=>{
  const item=await fixture();
  try{
    const dbClock=await clock(item.db);
    await mapRoom(item.db);
    await message(item.db,{id:1,createdAt:new Date(Date.parse(dbClock.cutoff)-1000).toISOString(),text:'eligible'});
    await message(item.db,{id:2,createdAt:'not-a-time',text:'invalid'});
    await enable(item.db);
    await enqueueNextChatRetentionRun(item.db,{
      mode:'purge',...await retentionRequest(item.db,dbClock),
    });
    const result=await runChatRetentionWorker({db:item.db,workerId:'invalid-worker',enabled:true,mode:'purge'});
    assert.equal(result.status,'dead_letter');
    let run=(await item.db.execute(`SELECT id,last_error_code FROM chat_retention_runs`)).rows[0];
    assert.equal(run.last_error_code,'RETENTION_TIMESTAMP_INVALID');
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM pair_messages`)).rows[0].count),2);
    await item.db.execute({sql:`UPDATE pair_messages SET created_at=? WHERE id=2`,args:[dbClock.now]});
    assert.equal(await replayChatRetentionRun(item.db,{
      runId:Number(run.id),reason:'CONFIGURATION_FIXED',
    }),true);
    await item.db.execute({
      sql:`UPDATE pair_messages SET created_at=? WHERE id=2`,
      args:[new Date(Date.parse(dbClock.now)+60_000).toISOString()],
    });
    const future=await runChatRetentionWorker({db:item.db,workerId:'future-worker',enabled:true,mode:'purge'});
    assert.equal(future.status,'dead_letter');
    run=(await item.db.execute(`SELECT last_error_code FROM chat_retention_runs`)).rows[0];
    assert.equal(run.last_error_code,'RETENTION_TIMESTAMP_FUTURE');
  }finally{ item.close(); }
});

test('transient failures retry, exhaust to dead letter, and can be replayed',async()=>{
  const item=await fixture();
  try{
    const dbClock=await clock(item.db);
    await mapRoom(item.db);
    await message(item.db,{id:1,createdAt:new Date(Date.parse(dbClock.cutoff)-1000).toISOString()});
    await enable(item.db);
    await enqueueNextChatRetentionRun(item.db,{
      mode:'purge',maxFailures:2,...await retentionRequest(item.db,dbClock),
    });
    let failures=0;
    const faultDb={
      execute:item.db.execute.bind(item.db),batch:item.db.batch.bind(item.db),
      async transaction(modeValue){
        const transaction=await item.db.transaction(modeValue);
        return {
          execute(statement){
            if(String(statement?.sql||statement).includes('julianday(created_at) IS NULL')&&failures<2){
              failures+=1;
              return Promise.reject(new Error('private raw database failure with body'));
            }
            return transaction.execute(statement);
          },
          commit:()=>transaction.commit(),rollback:()=>transaction.rollback(),close:()=>transaction.close(),
        };
      },
    };
    const first=await runChatRetentionWorker({db:faultDb,workerId:'retry-worker',enabled:true,mode:'purge'});
    assert.equal(first.status,'retry');
    await item.db.execute(`UPDATE chat_retention_runs SET next_attempt_at='2000-01-01T00:00:00.000Z'`);
    const second=await runChatRetentionWorker({db:faultDb,workerId:'retry-worker',enabled:true,mode:'purge'});
    assert.equal(second.status,'dead_letter');
    const run=(await item.db.execute(`SELECT id,failure_count,last_error_code FROM chat_retention_runs`)).rows[0];
    assert.deepEqual([Number(run.failure_count),run.last_error_code],[2,'RETENTION_FAILED']);
    assert.equal(await replayChatRetentionRun(item.db,{
      runId:Number(run.id),reason:'TRANSIENT_FAILURE_CLEARED',
    }),true);
    const recovered=await runChatRetentionWorker({db:item.db,workerId:'recovery-worker',enabled:true,mode:'purge'});
    assert.equal(recovered.status,'completed');
  }finally{ item.close(); }
});

test('unmapped rooms fail closed and metrics expose only capped counts, timings, modes, and states',async()=>{
  const item=await fixture();
  try{
    const dbClock=await clock(item.db);
    await message(item.db,{id:1,createdAt:new Date(Date.parse(dbClock.cutoff)-1000).toISOString(),text:'never-log-this'});
    await enable(item.db);
    const queued=await enqueueNextChatRetentionRun(item.db,{
      mode:'purge',...await retentionRequest(item.db,dbClock),
    });
    assert.deepEqual(queued,{created:false,runId:null,cutoffAt:dbClock.cutoff});
    const metrics=await readChatRetentionMetrics(item.db);
    assert.equal(metrics.anomalies.unmappedCount,1);
    const serialized=JSON.stringify(metrics);
    assert.doesNotMatch(serialized,/never-log-this|circle:|weekId|pairGroupId|sender|message/i);
  }finally{ item.close(); }
});

test('legacy scope adoption is idempotent and rejects ambiguous ownership',async()=>{
  const item=await fixture();
  try{
    await item.db.batch([
      `INSERT INTO circles (id,public_id,slug,name,is_primary) VALUES (1,'public-one','one','One',1)`,
      `INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
        (2,'a@example.test','hash','A','#111111'),(3,'b@example.test','hash','B','#222222')`,
      `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES
        (1,2,'owner','active'),(1,3,'member','active')`,
      `INSERT INTO pairing_weeks (id,week_label,week_start) VALUES (10,'2026-W01','2026-01-01')`,
      `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id)
        VALUES (20,10,2,3,NULL)`,
    ],'write');
    assert.deepEqual(await adoptChatRetentionScope(item.db,{
      scope:{scopeKey:'circle:1',circleId:1,weekId:10,pairGroupId:20},
    }),{created:true});
    assert.deepEqual(await adoptChatRetentionScope(item.db,{
      scope:{scopeKey:'circle:1',circleId:1,weekId:10,pairGroupId:20},
    }),{created:false});
    await assert.rejects(()=>adoptChatRetentionScope(item.db,{
      scope:{scopeKey:'circle:2',circleId:2,weekId:10,pairGroupId:20},
    }),error=>error instanceof ChatRetentionError&&error.code==='RETENTION_SCOPE_CONFLICT');
  }finally{ item.close(); }
});

test('environment and database kill switches default closed',async()=>{
  const item=await fixture();
  try{
    const result=await runChatRetentionWorker({
      db:item.db,workerId:'disabled-worker',enabled:false,mode:'purge',
    });
    assert.deepEqual({...result,durationMs:0},{
      disabled:true,claimed:0,batches:0,eligible:0,deleted:0,status:'disabled',durationMs:0,
    });
    assert.ok(Number.isSafeInteger(result.durationMs)&&result.durationMs>=0);
    const control=await item.db.execute(`SELECT COUNT(*) AS count FROM chat_retention_control`);
    assert.equal(Number(control.rows[0].count),0);
    let metrics=await readChatRetentionMetrics(item.db);
    assert.deepEqual(metrics.control,{
      present:false,enabled:false,generation:0,
      policyVersion:'private-beta-v1',retentionDays:90,
    });
    await enable(item.db);
    metrics=await readChatRetentionMetrics(item.db);
    assert.deepEqual(metrics.control,{
      present:true,enabled:true,generation:1,
      policyVersion:'private-beta-v1',retentionDays:90,
    });
    assert.equal(CHAT_RETENTION_POLICY.retentionDays,90);
  }finally{ item.close(); }
});
