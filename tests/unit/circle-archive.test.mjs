import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import {
  archiveSecondaryCircle,
  CircleArchiveError,
  parseCircleArchive,
} from '../../api/_circle-archive.js';
import { listSessionCircleContexts } from '../../api/_active-circle.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const NOW=1_795_000_000;
const SESSION_A='a'.repeat(64);
const SESSION_B='b'.repeat(64);
const SESSION_C='c'.repeat(64);
const SESSION_D='d'.repeat(64);
const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const CYCLE_KEY='e'.repeat(64);

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-circle-archive-'));
  const url=`file:${join(directory,'test.sqlite')}`;
  const db=createClient({url});
  return {
    db,url,
    client(){ return createClient({url}); },
    close(){ db.close(); rmSync(directory,{recursive:true,force:true}); },
  };
}

async function migrate(db){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db,{migrations:EXECUTABLE_MIGRATIONS});
  await applyMigrations(db,{migrations:EXECUTABLE_MIGRATIONS,
    expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY});
}

async function seed(db,{includeStranded=false}={}){
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
      (1,'owner@example.test','hash','Owner','#111111',0),
      (2,'member@example.test','hash','Member','#222222',0),
      (3,'other-owner@example.test','hash','Other owner','#333333',0),
      (4,'stranded@example.test','hash','Stranded','#444444',0)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES
      (10,'circle-primary','primary','Primary',1,1),
      (20,'circle-secondary','secondary','Secondary',0,1),
      (30,'circle-other','other','Other',0,3)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES
      (10,1,'owner','active'),(10,2,'member','active'),
      (20,1,'owner','active'),(20,2,'member','active'),(20,3,'owner','active'),
      (30,3,'owner','active')`,
    {sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at) VALUES
      (?,1,?,?),(?,1,?,?),(?,2,?,?),(?,3,?,?)`,
    args:[SESSION_A,NOW-60,4_102_444_800,SESSION_B,NOW-60,4_102_444_800,
      SESSION_C,NOW-60,4_102_444_800,SESSION_D,NOW-60,4_102_444_800]},
    {sql:`INSERT INTO auth_session_circle_contexts
      (session_hash,user_id,circle_id,context_version,updated_at) VALUES
      (?,1,20,4,?),(?,1,10,8,?),(?,2,20,7,?),(?,3,20,9,?)`,
    args:[SESSION_A,NOW,SESSION_B,NOW,SESSION_C,NOW,SESSION_D,NOW]},
    {sql:`INSERT INTO auth_recent_proofs (session_hash,user_id,authenticated_at,method)
      VALUES (?,1,?,'password')`,args:[SESSION_A,NOW-10]},
    `INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
      VALUES ('11111111-1111-4111-8111-111111111111',20,'${'1'.repeat(64)}','${'2'.repeat(64)}',1,
        '2026-09-20T00:00:00.000Z','2099-09-20T00:00:00.000Z')`,
    {sql:`INSERT INTO pairing_cycles
      (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
      VALUES ('circle:20',20,?,'2099-W38','2099-09-13T07:00:00.000Z','2099-09-20T07:00:00.000Z',
        '2099-09-13T07:00:00.000Z','Europe/London','cycle_default')`,args:[CYCLE_KEY]},
    {sql:`INSERT INTO circle_pairing_publications
      (id,scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,
       generation_token,algorithm_version,algorithm_seed,participant_count)
      VALUES (40,'circle:20',20,?,'2099-W38','2099-09-13T07:00:00.000Z','2099-09-20T07:00:00.000Z',
        '2099-09-13T07:00:00.000Z','Europe/London','11111111-1111-4111-8111-111111111111',
        'fair-seeded-v1',?,2)`,args:[CYCLE_KEY,`circle:20:${CYCLE_KEY}:weekly`]},
    {sql:`INSERT INTO circle_pairing_eligibility
      (publication_id,scope_key,circle_id,cycle_key,user_id,is_available,availability_version,
       availability_source,position,group_position,group_size,member_position)
      VALUES (40,'circle:20',20,?,1,1,0,'cycle_default',0,0,2,0),
             (40,'circle:20',20,?,2,1,0,'cycle_default',1,0,2,1)`,args:[CYCLE_KEY,CYCLE_KEY]},
    {sql:`INSERT INTO circle_pairing_groups
      (id,publication_id,scope_key,circle_id,cycle_key,position,member_count,user_a_id,
       user_b_id,user_b_available,user_b_member_position,is_solo)
      VALUES (50,40,'circle:20',20,?,0,2,1,2,1,1,0)`,args:[CYCLE_KEY]},
    {sql:`INSERT INTO circle_pair_schedules
      (id,schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,member_count,
       user_a_id,user_b_id,is_solo,revision,agreed_time,created_at,updated_at)
      VALUES (60,?,40,'circle:20',20,?,50,2,1,2,0,1,'2099-09-19T18:00:00.000Z',
        '2026-09-20T00:00:00.000Z','2026-09-20T00:00:00.000Z')`,args:['3'.repeat(64),CYCLE_KEY]},
    {sql:`INSERT INTO circle_pair_schedule_proposals
      (schedule_id,schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,member_count,
       user_a_id,user_b_id,is_solo,proposal_key,instant,proposed_by,created_at)
      VALUES (60,?,40,'circle:20',20,?,50,2,1,2,0,?,'2099-09-19T18:00:00.000Z',1,
        '2026-09-20T00:00:00.000Z')`,args:['3'.repeat(64),CYCLE_KEY,'4'.repeat(64)]},
  ],'write');
  if(includeStranded){
    await db.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status)
      VALUES (20,4,'member','active')`);
  }
}

function payload(userId=1,sessionHash=SESSION_A){ return {id:userId,sessionHash}; }
function input(circlePublicId='circle-secondary',expectedContextVersion=4){
  return {circlePublicId,expectedContextVersion};
}

async function retainedSnapshot(db){
  const tables=['circle_memberships','circle_invitations','pairing_cycles','circle_pairing_publications',
    'circle_pairing_eligibility','circle_pairing_groups','circle_pair_schedules','circle_pair_schedule_proposals'];
  const result={};
  for(const table of tables){
    result[table]=(await db.execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows.map(row=>({...row}));
  }
  return result;
}

test('archive input is exact and accepts only a public circle id plus context CAS',()=>{
  assert.deepEqual(parseCircleArchive({
    circle_public_id:'circle-secondary',expected_context_version:4,
  }),input());
  for(const body of [null,{},
    {circle_public_id:'circle-secondary'},
    {circle_public_id:'circle-secondary',expected_context_version:'4'},
    {circle_public_id:' circle-secondary',expected_context_version:4},
    {circle_public_id:'circle-secondary',expected_context_version:4,circle_id:20},
  ]) assert.throws(()=>parseCircleArchive(body),error=>
    error instanceof CircleArchiveError&&error.code==='CIRCLE_ARCHIVE_INPUT_INVALID');
});

test('owner archive retains immutable data and atomically falls every selected session back',async()=>{
  const item=fixture();
  try{
    await migrate(item.db); await seed(item.db);
    const retained=await retainedSnapshot(item.db);
    const result=await archiveSecondaryCircle(item.db,payload(),input(),{nowSeconds:NOW});
    assert.deepEqual(result,{ok:true,changed:true,
      circle:{public_id:'circle-secondary',name:'Secondary'},context_version:5});
    const archived=await item.db.execute(`SELECT archived_at FROM circles WHERE id=20`);
    assert.match(String(archived.rows[0].archived_at),/Z$/);
    assert.deepEqual(await retainedSnapshot(item.db),retained,
      'memberships, invitations, publications, schedules, and proposals are retained byte-for-byte');
    const contexts=await item.db.execute(`SELECT session_hash,user_id,circle_id,context_version
      FROM auth_session_circle_contexts ORDER BY session_hash`);
    assert.deepEqual(contexts.rows.map(row=>[
      String(row.session_hash),Number(row.user_id),Number(row.circle_id),Number(row.context_version),
    ]),[
      [SESSION_A,1,10,5],
      [SESSION_B,1,10,8],
      [SESSION_C,2,10,8],
      [SESSION_D,3,30,10],
    ]);
    const listed=await listSessionCircleContexts(item.db,payload());
    assert.deepEqual(listed.circles.map(circle=>circle.public_id),['circle-primary']);
    assert.equal(listed.active.public_id,'circle-primary');
    assert.equal(listed.context_version,5);
    const audits=await item.db.execute(`SELECT event_type,actor_user_id,subject_user_id,dedupe_key
      FROM circle_audit_events WHERE circle_id=20`);
    assert.deepEqual(audits.rows.map(row=>[row.event_type,Number(row.actor_user_id),
      Number(row.subject_user_id),row.dedupe_key]),[
      ['circle.archived',1,1,'circle-archived:20'],
    ]);
  }finally{ item.close(); }
});

test('same owner replay is idempotent while stale context and cross-circle identities disclose nothing',async()=>{
  const item=fixture();
  try{
    await migrate(item.db); await seed(item.db);
    const first=await archiveSecondaryCircle(item.db,payload(),input(),{nowSeconds:NOW});
    const replay=await archiveSecondaryCircle(item.db,payload(),input(),{nowSeconds:NOW});
    assert.equal(first.changed,true);
    assert.deepEqual(replay,{ok:true,changed:false,
      circle:{public_id:'circle-secondary',name:'Secondary'},context_version:5});
    assert.equal(Number((await item.db.execute(`SELECT context_version FROM auth_session_circle_contexts
      WHERE session_hash='${SESSION_A}'`)).rows[0].context_version),5);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_audit_events
      WHERE event_type='circle.archived'`)).rows[0].count),1);

    assert.deepEqual(await archiveSecondaryCircle(item.db,payload(),input('circle-other',4),{nowSeconds:NOW}),
      {ok:false,reason:'circle_unavailable'});
  }finally{ item.close(); }
});

test('an active non-owner and a foreign owner receive the same unavailable result without mutation',async()=>{
  const item=fixture();
  try{
    await migrate(item.db); await seed(item.db);
    const before=await retainedSnapshot(item.db);
    assert.deepEqual(await archiveSecondaryCircle(item.db,payload(2,SESSION_C),input('circle-secondary',7),{
      nowSeconds:NOW,
    }),{ok:false,reason:'circle_unavailable'});
    assert.deepEqual(await archiveSecondaryCircle(item.db,payload(),input('circle-other',4),{
      nowSeconds:NOW,
    }),{ok:false,reason:'circle_unavailable'});
    assert.equal((await item.db.execute(`SELECT archived_at FROM circles WHERE id IN (20,30)
      AND archived_at IS NOT NULL`)).rows.length,0);
    assert.deepEqual(await retainedSnapshot(item.db),before);
  }finally{ item.close(); }
});

test('primary, last-circle, stale-context, and recent-auth safety fail before mutation',async()=>{
  for(const scenario of ['primary','last','stale','recent']){
    const item=fixture();
    try{
      await migrate(item.db); await seed(item.db,{includeStranded:scenario==='last'});
      let archiveInput=input();
      if(scenario==='primary'){
        archiveInput=input('circle-primary',8);
        await item.db.execute({sql:`INSERT INTO auth_recent_proofs
          (session_hash,user_id,authenticated_at,method) VALUES (?,1,?,'password')
          ON CONFLICT(session_hash) DO UPDATE SET authenticated_at=excluded.authenticated_at`,args:[SESSION_B,NOW-10]});
      }
      if(scenario==='stale') archiveInput=input('circle-secondary',3);
      if(scenario==='recent') await item.db.execute({sql:`DELETE FROM auth_recent_proofs WHERE session_hash=?`,args:[SESSION_A]});
      const before=await retainedSnapshot(item.db);
      if(scenario==='recent'){
        await assert.rejects(
          archiveSecondaryCircle(item.db,payload(),archiveInput,{nowSeconds:NOW}),
          error=>error?.code==='RECENT_AUTH_REQUIRED',
        );
      }else{
        const actorPayload=scenario==='primary'?payload(1,SESSION_B):payload();
        const result=await archiveSecondaryCircle(item.db,actorPayload,archiveInput,{nowSeconds:NOW});
        assert.deepEqual(result,{ok:false,reason:scenario==='primary'?'primary_circle'
          :scenario==='last'?'last_circle':'context_changed'});
      }
      assert.equal((await item.db.execute(`SELECT archived_at FROM circles WHERE id=20`)).rows[0].archived_at,null);
      assert.deepEqual(await retainedSnapshot(item.db),before);
      assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_audit_events
        WHERE event_type='circle.archived'`)).rows[0].count),0);
    }finally{ item.close(); }
  }
});

test('concurrent duplicate archive requests converge on one audit and one context advance',async()=>{
  const item=fixture(); let second;
  try{
    await migrate(item.db); await seed(item.db);
    second=item.client(); await prepareMigrationConnection(second);
    const outcomes=await Promise.all([
      archiveSecondaryCircle(item.db,payload(),input(),{nowSeconds:NOW,maxAttempts:6,baseDelayMs:2}),
      archiveSecondaryCircle(second,payload(),input(),{nowSeconds:NOW,maxAttempts:6,baseDelayMs:2}),
    ]);
    assert.deepEqual(new Set(outcomes.map(result=>result.changed)),new Set([true,false]));
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_audit_events
      WHERE event_type='circle.archived'`)).rows[0].count),1);
    assert.equal(Number((await item.db.execute({sql:`SELECT context_version
      FROM auth_session_circle_contexts WHERE session_hash=?`,args:[SESSION_A]})).rows[0].context_version),5);
  }finally{ try{ second?.close(); }catch{} item.close(); }
});

test('an applied-but-throwing commit is not retried and the exact external replay converges',async()=>{
  const item=fixture();
  try{
    await migrate(item.db); await seed(item.db);
    let transactionCount=0;
    const ambiguousDb={
      async transaction(mode){
        transactionCount+=1;
        const transaction=await item.db.transaction(mode);
        return new Proxy(transaction,{get(target,property){
          if(property==='commit') return async()=>{
            await target.commit();
            throw Object.assign(new Error('lost commit response'),{code:'SQLITE_BUSY'});
          };
          const value=target[property];
          return typeof value==='function'?value.bind(target):value;
        }});
      },
    };
    await assert.rejects(
      archiveSecondaryCircle(ambiguousDb,payload(),input(),{nowSeconds:NOW,maxAttempts:6,baseDelayMs:0}),
      error=>error instanceof CircleArchiveError&&error.code==='CIRCLE_ARCHIVE_COMMIT_UNKNOWN',
    );
    assert.equal(transactionCount,1);
    const replay=await archiveSecondaryCircle(item.db,payload(),input(),{nowSeconds:NOW});
    assert.equal(replay.changed,false);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_audit_events
      WHERE event_type='circle.archived'`)).rows[0].count),1);
  }finally{ item.close(); }
});

test('pre-commit retry revalidates the live session and audit failure rolls back archive and fallback',async()=>{
  for(const scenario of ['retry','audit']){
    const item=fixture();
    try{
      await migrate(item.db); await seed(item.db);
      let attempts=0;
      const guardedDb={
        async transaction(mode){
          attempts+=1;
          if(scenario==='retry'&&attempts===2){
            await item.db.execute({sql:`UPDATE auth_sessions SET revoked_at=? WHERE session_hash=?`,
              args:[NOW,SESSION_A]});
          }
          const transaction=await item.db.transaction(mode);
          let injected=false;
          return new Proxy(transaction,{get(target,property){
            if(property==='execute') return async statement=>{
              const sql=String(statement?.sql||statement);
              if(!injected&&scenario==='retry'&&attempts===1&&sql.includes('SELECT affected.user_id')){
                injected=true;
                throw Object.assign(new Error('database is locked'),{code:'SQLITE_BUSY'});
              }
              if(scenario==='audit'&&sql.includes('INSERT INTO circle_audit_events')){
                throw new Error('forced audit failure');
              }
              return target.execute(statement);
            };
            const value=target[property];
            return typeof value==='function'?value.bind(target):value;
          }});
        },
      };
      if(scenario==='retry'){
        assert.deepEqual(await archiveSecondaryCircle(guardedDb,payload(),input(),{
          nowSeconds:NOW,maxAttempts:3,baseDelayMs:0,
        }),{ok:false,reason:'session_changed'});
        assert.equal(attempts,2);
      }else{
        await assert.rejects(archiveSecondaryCircle(guardedDb,payload(),input(),{
          nowSeconds:NOW,maxAttempts:1,baseDelayMs:0,
        }),/forced audit failure/);
      }
      assert.equal((await item.db.execute(`SELECT archived_at FROM circles WHERE id=20`)).rows[0].archived_at,null);
      assert.equal(Number((await item.db.execute({sql:`SELECT context_version
        FROM auth_session_circle_contexts WHERE session_hash=?`,args:[SESSION_A]})).rows[0].context_version),4);
      assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_audit_events
        WHERE event_type='circle.archived'`)).rows[0].count),0);
    }finally{ item.close(); }
  }
});
