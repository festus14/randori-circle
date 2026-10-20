// Coverage package P5: every action and fail-closed environment path of
// scripts/chat-retention.mjs, run in-process against a real migrated database.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import { chatRetentionEvidenceBindingDigest } from '../../api/_chat-retention.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { runChatRetentionCli } from '../../scripts/chat-retention.mjs';
import { copyMigratedDatabase } from '../support/migrated-db.mjs';

// Pre-cutover (no circles) data keeps the migration state ready, so the CLI
// paths are exercised with the local-runtime scope; circle scopes are covered
// by tests/unit/cov-p5-chat-retention-api.test.mjs.
const SCOPE_ENV=Object.freeze({
  CHAT_RETENTION_SCOPE_KEY:'local',CHAT_RETENTION_WEEK_ID:'10',CHAT_RETENTION_PAIR_GROUP_ID:'20',
});
const LOCAL_ADOPT=Object.freeze({CHAT_RETENTION_ACTION:'adopt_scope',...SCOPE_ENV,CHAT_RETENTION_LOCAL_ADOPTION:'true'});

async function fixture({migrate=true}={}){
  const directory=mkdtempSync(join(tmpdir(),'randori-cov-p5-retention-cli-'));
  const url=`file:${join(directory,'cli.sqlite')}`;
  if(migrate) await copyMigratedDatabase(join(directory,'cli.sqlite'));
  const db=createClient({url});
  if(migrate) await prepareMigrationConnection(db);
  const opened=[];
  const createDatabase=options=>{
    const client=createClient({url:options.url});
    const record={options,closed:false};
    opened.push(record);
    const close=client.close.bind(client);
    client.close=()=>{ record.closed=true; close(); };
    return client;
  };
  return {
    db,url,opened,
    cli:(env)=>runChatRetentionCli({env:{TURSO_DATABASE_URL:url,...env},createDatabase}),
    close(){ db.close(); rmSync(directory,{recursive:true,force:true}); },
  };
}

async function withFixture(fn,options){
  const item=await fixture(options);
  try{ return await fn(item); }finally{ item.close(); }
}

async function seedPairing(db){
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
      (2,'a@example.test','hash','A','#111111'),(3,'b@example.test','hash','B','#222222')`,
    `INSERT INTO pairing_weeks (id,week_label,week_start) VALUES (10,'2026-W01','2026-01-01')`,
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id) VALUES (20,10,2,3,NULL)`,
  ],'write');
}

async function gateEnv(db,{sourceMaxMessageId=1}={}){
  const row=(await db.execute(`SELECT
    strftime('%Y-%m-%dT00:00:00.000Z','now','-90 days') AS cutoff,
    strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes') AS exported,
    strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute') AS backup`)).rows[0];
  const scope={scopeKey:'local',circleId:null,weekId:10,pairGroupId:20};
  const backup={digest:'a'.repeat(64),throughAt:String(row.cutoff),completedAt:String(row.backup),sourceMaxMessageId};
  const exported={digest:'b'.repeat(64),throughAt:String(row.cutoff),completedAt:String(row.exported),sourceMaxMessageId};
  return {
    cutoff:String(row.cutoff),
    env:{
      CHAT_RETENTION_BACKUP_EVIDENCE_DIGEST:backup.digest,
      CHAT_RETENTION_BACKUP_SCOPE_BINDING_DIGEST:chatRetentionEvidenceBindingDigest({kind:'backup',scope,...backup}),
      CHAT_RETENTION_BACKUP_SOURCE_MAX_MESSAGE_ID:String(sourceMaxMessageId),
      CHAT_RETENTION_BACKUP_THROUGH_AT:backup.throughAt,
      CHAT_RETENTION_BACKUP_COMPLETED_AT:backup.completedAt,
      CHAT_RETENTION_EXPORT_EVIDENCE_DIGEST:exported.digest,
      CHAT_RETENTION_EXPORT_SCOPE_BINDING_DIGEST:chatRetentionEvidenceBindingDigest({kind:'export',scope,...exported}),
      CHAT_RETENTION_EXPORT_SOURCE_MAX_MESSAGE_ID:String(sourceMaxMessageId),
      CHAT_RETENTION_EXPORT_THROUGH_AT:exported.throughAt,
      CHAT_RETENTION_EXPORT_COMPLETED_AT:exported.completedAt,
    },
  };
}

const isType=pattern=>error=>error instanceof TypeError&&pattern.test(error.message);

test('the CLI rejects unknown actions and a missing database URL before connecting',async()=>{
  let connected=false;
  const createDatabase=()=>{ connected=true; throw new Error('must not connect'); };
  await assert.rejects(()=>runChatRetentionCli({env:{CHAT_RETENTION_ACTION:'purge_all',TURSO_DATABASE_URL:'file:x'},createDatabase}),
    isType(/invalid retention action/));
  await assert.rejects(()=>runChatRetentionCli({env:{CHAT_RETENTION_ACTION:'status',TURSO_DATABASE_URL:'  '},createDatabase}),
    isType(/missing database URL/));
  assert.equal(connected,false);
});

test('status is the default action, passes the auth token, and always closes the connection',async()=>{
  await withFixture(async item=>{
    const result=await runChatRetentionCli({
      env:{TURSO_DATABASE_URL:item.url,TURSO_AUTH_TOKEN:' token-value '},
      createDatabase:options=>{
        assert.deepEqual(options,{url:item.url,authToken:'token-value'});
        const client=createClient({url:options.url});
        const close=client.close.bind(client);
        client.close=()=>{ close(); throw new Error('close failure is swallowed'); };
        return client;
      },
    });
    assert.equal(result.ok,true);
    assert.equal(result.action,'status');
    assert.equal(result.metrics.control.present,false);
    assert.equal(Object.isFrozen(result),true);
    await item.cli({CHAT_RETENTION_ACTION:'Status'});
    assert.equal(item.opened[0].options.authToken,undefined);
    assert.equal(item.opened[0].closed,true);
  });
});

test('an unmigrated database fails closed with a fixed schema error and the connection is closed',async()=>{
  await withFixture(async item=>{
    await assert.rejects(()=>item.cli({CHAT_RETENTION_ACTION:'status'}),
      error=>error.code==='RETENTION_SCHEMA_UNAVAILABLE');
    assert.equal(item.opened[0].closed,true);
  },{migrate:false});
});

test('enable and disable require an explicit compare-and-set generation',async()=>{
  await withFixture(async item=>{
    await assert.rejects(()=>item.cli({CHAT_RETENTION_ACTION:'enable'}),isType(/retention control generation/));
    await assert.rejects(()=>item.cli({CHAT_RETENTION_ACTION:'enable',CHAT_RETENTION_EXPECTED_GENERATION:'-1'}),
      isType(/retention control generation/));
    await assert.rejects(()=>item.cli({CHAT_RETENTION_ACTION:'enable',CHAT_RETENTION_EXPECTED_GENERATION:'1.5'}),
      isType(/retention control generation/));
    assert.deepEqual(await item.cli({CHAT_RETENTION_ACTION:'enable',CHAT_RETENTION_EXPECTED_GENERATION:'0'}),
      {ok:true,action:'enable',enabled:true,generation:1});
    await assert.rejects(()=>item.cli({CHAT_RETENTION_ACTION:'disable',CHAT_RETENTION_EXPECTED_GENERATION:'0'}),
      error=>error.code==='RETENTION_CONTROL_STALE');
    assert.deepEqual(await item.cli({CHAT_RETENTION_ACTION:'disable',CHAT_RETENTION_EXPECTED_GENERATION:'1'}),
      {ok:true,action:'disable',enabled:false,generation:2});
  });
});

test('scope adoption validates the scope environment and honours the local-runtime opt-in',async()=>{
  await withFixture(async item=>{
    await seedPairing(item.db);
    await assert.rejects(()=>item.cli({CHAT_RETENTION_ACTION:'adopt-scope'}),isType(/missing retention scope/));
    await assert.rejects(()=>item.cli({CHAT_RETENTION_ACTION:'adopt_scope',CHAT_RETENTION_SCOPE_KEY:'circle:1'}),
      isType(/invalid retention circle/));
    await assert.rejects(()=>item.cli({...LOCAL_ADOPT,CHAT_RETENTION_WEEK_ID:'0'}),isType(/invalid retention week/));
    await assert.rejects(()=>item.cli({...LOCAL_ADOPT,CHAT_RETENTION_PAIR_GROUP_ID:'x'}),
      isType(/invalid retention pair group/));
    await assert.rejects(()=>item.cli({CHAT_RETENTION_ACTION:'adopt_scope',CHAT_RETENTION_SCOPE_KEY:'circle:1',
      CHAT_RETENTION_CIRCLE_ID:'1',CHAT_RETENTION_WEEK_ID:'10',CHAT_RETENTION_PAIR_GROUP_ID:'20'}),
      error=>error.code==='RETENTION_SCOPE_AMBIGUOUS','a circle that does not exist cannot own the room');
    await assert.rejects(()=>item.cli({...LOCAL_ADOPT,CHAT_RETENTION_LOCAL_ADOPTION:'yes'}),
      error=>error.code==='RETENTION_SCOPE_AMBIGUOUS','local adoption needs the exact opt-in');
    assert.deepEqual(await item.cli(LOCAL_ADOPT),{ok:true,action:'adopt_scope',created:true});
    assert.deepEqual(await item.cli(LOCAL_ADOPT),{ok:true,action:'adopt_scope',created:false});
  });
});

test('tenant and room holds require a reason, and releases report whether a hold was active',async()=>{
  await withFixture(async item=>{
    await seedPairing(item.db);
    await item.cli(LOCAL_ADOPT);
    const tenant={CHAT_RETENTION_SCOPE_KEY:'local'};
    await assert.rejects(()=>item.cli({CHAT_RETENTION_ACTION:'hold_tenant',...tenant}),isType(/missing retention reason/));
    assert.deepEqual(await item.cli({CHAT_RETENTION_ACTION:'hold_tenant',...tenant,CHAT_RETENTION_REASON_CODE:'LEGAL_REQUEST'}),
      {ok:true,action:'hold_tenant',active:true});
    await assert.rejects(()=>item.cli({CHAT_RETENTION_ACTION:'hold_room',...tenant,CHAT_RETENTION_REASON_CODE:'EXPORT'}),
      isType(/invalid retention week/),'room holds need the room coordinates');
    assert.deepEqual(await item.cli({CHAT_RETENTION_ACTION:'hold-room',...SCOPE_ENV,CHAT_RETENTION_REASON_CODE:'EXPORT'}),
      {ok:true,action:'hold_room',active:true});
    assert.deepEqual(await item.cli({CHAT_RETENTION_ACTION:'release_room',...SCOPE_ENV}),
      {ok:true,action:'release_room',released:true});
    assert.deepEqual(await item.cli({CHAT_RETENTION_ACTION:'release_room',...SCOPE_ENV}),
      {ok:true,action:'release_room',released:false});
    assert.deepEqual(await item.cli({CHAT_RETENTION_ACTION:'release_tenant',...tenant}),
      {ok:true,action:'release_tenant',released:true});
    const holds=(await item.db.execute(`SELECT hold_level,status FROM chat_retention_legal_holds ORDER BY hold_level`)).rows;
    assert.deepEqual(holds.map(row=>[row.hold_level,row.status]),[['room','released'],['tenant','released']]);
  });
});

test('replay requires a run id and an allowed reason and reports whether anything was replayed',async()=>{
  await withFixture(async item=>{
    await assert.rejects(()=>item.cli({CHAT_RETENTION_ACTION:'replay',CHAT_RETENTION_REASON_CODE:'OPERATOR_RETRY'}),
      isType(/invalid retention run/));
    await assert.rejects(()=>item.cli({CHAT_RETENTION_ACTION:'replay',CHAT_RETENTION_RUN_ID:'1'}),
      isType(/missing retention replay reason/));
    await assert.rejects(()=>item.cli({CHAT_RETENTION_ACTION:'replay',CHAT_RETENTION_RUN_ID:'1',
      CHAT_RETENTION_REASON_CODE:'BECAUSE'}),isType(/replay reason/));
    assert.deepEqual(await item.cli({CHAT_RETENTION_ACTION:'replay',CHAT_RETENTION_RUN_ID:'1',
      CHAT_RETENTION_REASON_CODE:'OPERATOR_RETRY'}),{ok:true,action:'replay',replayed:false});
  });
});

test('run stays a no-op worker pass while disabled and never needs evidence',async()=>{
  await withFixture(async item=>{
    const result=await item.cli({CHAT_RETENTION_ACTION:'run'});
    assert.equal(result.mode,'dry_run');
    assert.equal(result.enqueued,false);
    assert.equal(result.worker.status,'disabled');
    await assert.rejects(()=>item.cli({CHAT_RETENTION_ACTION:'run',CHAT_RETENTION_MODE:'erase'}),
      isType(/invalid chat retention mode/));
  });
});

test('an enabled run demands complete backup and export evidence, then enqueues and purges',async()=>{
  await withFixture(async item=>{
    await seedPairing(item.db);
    await item.cli(LOCAL_ADOPT);
    await item.cli({CHAT_RETENTION_ACTION:'enable',CHAT_RETENTION_EXPECTED_GENERATION:'0'});
    const {cutoff,env:gate}=await gateEnv(item.db);
    await item.db.execute({
      sql:`INSERT INTO pair_messages (id,week_id,pair_group_id,sender_id,message,created_at) VALUES (1,10,20,2,'old-private',?)`,
      args:[new Date(Date.parse(cutoff)-1000).toISOString()],
    });
    const run={CHAT_RETENTION_ACTION:'run',CHAT_RETENTION_ENABLED:'true',CHAT_RETENTION_MODE:'purge',...SCOPE_ENV};
    for(const [name,pattern] of [
      ['CHAT_RETENTION_BACKUP_EVIDENCE_DIGEST',/missing backup evidence digest/],
      ['CHAT_RETENTION_BACKUP_SCOPE_BINDING_DIGEST',/missing backup scope binding digest/],
      ['CHAT_RETENTION_BACKUP_SOURCE_MAX_MESSAGE_ID',/invalid backup source maximum message/],
      ['CHAT_RETENTION_BACKUP_THROUGH_AT',/missing backup through time/],
      ['CHAT_RETENTION_BACKUP_COMPLETED_AT',/missing backup completion time/],
      ['CHAT_RETENTION_EXPORT_EVIDENCE_DIGEST',/missing export evidence digest/],
      ['CHAT_RETENTION_EXPORT_SCOPE_BINDING_DIGEST',/missing export scope binding digest/],
      ['CHAT_RETENTION_EXPORT_SOURCE_MAX_MESSAGE_ID',/invalid export source maximum message/],
      ['CHAT_RETENTION_EXPORT_THROUGH_AT',/missing export through time/],
      ['CHAT_RETENTION_EXPORT_COMPLETED_AT',/missing export completion time/],
    ]){
      const partial={...run,...gate};
      delete partial[name];
      await assert.rejects(()=>item.cli(partial),isType(pattern),name);
    }
    await assert.rejects(()=>item.cli({...gate,...run,CHAT_RETENTION_SCOPE_KEY:''}),isType(/missing retention scope/));
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM pair_messages`)).rows[0].count),1);

    const result=await item.cli({...run,...gate});
    assert.equal(result.enqueued,true);
    assert.equal(result.mode,'purge');
    assert.deepEqual({status:result.worker.status,deleted:result.worker.deleted},{status:'completed',deleted:1});
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM pair_messages`)).rows[0].count),0);
    assert.doesNotMatch(JSON.stringify(result),/old-private|local|file:/);
  });
});

test('the CLI entry point prints a fixed domain error code without leaking the database location',async()=>{
  await withFixture(async item=>{
    const result=spawnSync(process.execPath,['scripts/chat-retention.mjs'],{
      cwd:process.cwd(),encoding:'utf8',
      env:{...process.env,CHAT_RETENTION_ACTION:'status',TURSO_DATABASE_URL:item.url},
    });
    assert.equal(result.status,2);
    assert.equal(result.stdout,'');
    assert.deepEqual(JSON.parse(result.stderr),{ok:false,error_code:'RETENTION_SCHEMA_UNAVAILABLE'});
    assert.doesNotMatch(result.stderr,/cli\.sqlite|randori-cov/);
  },{migrate:false});
});
