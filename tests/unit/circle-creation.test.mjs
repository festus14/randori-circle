import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import {
  CircleCreationError,
  MAX_OWNED_ACTIVE_CIRCLES_PER_ACCOUNT,
  createCircleAndSelect,
  parseCircleCreation,
} from '../../api/_circle-creation.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const SESSION_A='a'.repeat(64);
const SESSION_B='b'.repeat(64);
const REQUEST='request_opaque_1234567890';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-circle-create-'));
  const path=join(directory,'test.sqlite');
  const db=createClient({url:`file:${path}`});
  return {
    db,path,
    client(){ return createClient({url:`file:${path}`}); },
    close(){ db.close(); rmSync(directory,{recursive:true,force:true}); },
  };
}

async function migrate(db){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY});
}

async function seed(db,{secondUser=false}={}){
  const now=Math.floor(Date.now()/1000);
  await db.execute(`INSERT INTO auth_accounts
    (id,email,password_hash,display_name,color,is_demo) VALUES
    (1,'owner@example.test','hash','Owner','#111111',0)`);
  await db.execute(`INSERT INTO circles
    (id,public_id,slug,name,is_primary,created_by) VALUES
    (1,'circle-primary','primary','Primary',1,1)`);
  await db.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status)
    VALUES (1,1,'owner','active')`);
  await db.execute({sql:`INSERT INTO auth_sessions
    (session_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)`,args:[SESSION_A,1,now-10,now+3600]});
  if(secondUser){
    await db.execute(`INSERT INTO auth_accounts
      (id,email,password_hash,display_name,color,is_demo) VALUES
      (2,'other@example.test','hash','Other','#222222',0)`);
    await db.execute({sql:`INSERT INTO auth_sessions
      (session_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)`,args:[SESSION_B,2,now-10,now+3600]});
  }
}

function payload(userId=1,sessionHash=SESSION_A){ return {id:userId,sessionHash}; }
function input(name='Study Group',requestId=REQUEST){ return parseCircleCreation({name,request_id:requestId}); }
function uuid(number){ return `00000000-0000-4000-8000-${String(number).padStart(12,'0')}`; }
function uuids(){ let value=1; return ()=>uuid(value++); }

test('creation validation is exact, Unicode-safe, and bounded before persistence',()=>{
  assert.deepEqual(input(),{name:'Study Group',requestId:REQUEST});
  for(const body of [
    null,{},
    {name:'Study Group',request_id:REQUEST,role:'owner'},
    {name:' Study Group',request_id:REQUEST},
    {name:'Study\u0000Group',request_id:REQUEST},
    {name:'e\u0301',request_id:REQUEST},
    {name:'x'.repeat(81),request_id:REQUEST},
    {name:'Study Group',request_id:'short'},
    {name:'Study Group',request_id:`${REQUEST}.unsafe`},
  ]) assert.throws(()=>parseCircleCreation(body),error=>error.code==='CIRCLE_CREATE_INPUT_INVALID');
});

test('one transaction creates a secondary owner, receipt, audit, and monotonic selected context only',async()=>{
  const item=fixture();
  try{
    await migrate(item.db); await seed(item.db);
    await item.db.execute({sql:`INSERT INTO auth_session_circle_contexts
      (session_hash,user_id,circle_id,context_version,updated_at) VALUES (?,?,1,7,?)`,
    args:[SESSION_A,1,Math.floor(Date.now()/1000)]});
    const legacyTables=['pairing_weeks','pairing_groups','pairing_participants','pairing_week_runs',
      'pairing_email_outbox','pair_schedules','pair_messages','pair_room_snapshots','video_signals',
      'session_runs','ai_sessions','ai_feedback','ai_usage','ai_account_monthly_usage',
      'ai_account_monthly_reservations','ai_consents','user_notification_prefs','outbox_events',
      'pairing_cycles','pairing_cycle_availability','circle_pairing_publications',
      'circle_pairing_eligibility','circle_pairing_groups'];
    const before={};
    for(const table of legacyTables) before[table]=Number((await item.db.execute(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count);
    const result=await createCircleAndSelect(item.db,payload(),input(),{randomUuid:uuids()});
    assert.deepEqual(result,{
      ok:true,circle:{public_id:`circle_${uuid(1).replaceAll('-','')}`,name:'Study Group',role:'owner',is_primary:false},
      context_version:8,created:true,
    });
    const state=await item.db.execute(`SELECT circle.id,circle.slug,circle.is_primary,
      membership.role,membership.status,context.context_version,
      receipt.context_version,audit.event_type,audit.actor_user_id
      FROM circles circle
      JOIN circle_memberships membership ON membership.circle_id=circle.id
      JOIN circle_creation_requests receipt ON receipt.circle_id=circle.id
      JOIN circle_audit_events audit ON audit.id=receipt.audit_event_id
      JOIN auth_session_circle_contexts context ON context.circle_id=circle.id
      WHERE circle.public_id<>'circle-primary'`);
    assert.equal(state.rows.length,1);
    assert.equal(state.rows[0].slug,`circle-${uuid(1).replaceAll('-','')}`);
    assert.equal(Number(state.rows[0].is_primary),0);
    assert.equal(state.rows[0].role,'owner');
    assert.equal(state.rows[0].status,'active');
    assert.equal(Number(state.rows[0].context_version),8);
    assert.equal(state.rows[0].event_type,'circle.created');
    for(const table of legacyTables){
      assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count),before[table],table);
    }
  }finally{ item.close(); }
});

test('identical concurrent requests converge while cross-tenant opaque IDs stay isolated',async()=>{
  const item=fixture();
  let second;
  try{
    await migrate(item.db); await seed(item.db,{secondUser:true});
    const other=await createCircleAndSelect(item.db,payload(2,SESSION_B),input(),{randomUuid:()=>uuid(99)});
    assert.equal(other.created,true);
    second=item.client(); await prepareMigrationConnection(second);
    const [left,right]=await Promise.all([
      createCircleAndSelect(item.db,payload(),input(),{randomUuid:uuids(),maxAttempts:5}),
      createCircleAndSelect(second,payload(),input(),{randomUuid:uuids(),maxAttempts:5}),
    ]);
    assert.equal(left.circle.public_id,right.circle.public_id);
    assert.deepEqual(new Set([left.created,right.created]),new Set([true,false]));
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_creation_requests WHERE actor_user_id=1`)).rows[0].count),1);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_audit_events WHERE event_type='circle.created' AND actor_user_id=1`)).rows[0].count),1);
    second.close(); second=null;
    assert.notEqual(other.circle.public_id,left.circle.public_id);
  }finally{ try{ second?.close(); }catch{} item.close(); }
});

test('a receipt is bound to the exact name, session, audit, and unchanged selected result',async()=>{
  const item=fixture();
  try{
    await migrate(item.db); await seed(item.db);
    const first=await createCircleAndSelect(item.db,payload(),input(),{randomUuid:uuids()});
    const replay=await createCircleAndSelect(item.db,payload(),input(),{randomUuid:()=>{ throw new Error('must not generate'); }});
    assert.equal(replay.created,false);
    assert.equal(replay.circle.public_id,first.circle.public_id);
    assert.equal(replay.context_version,first.context_version);
    assert.equal((await createCircleAndSelect(item.db,payload(),input('Changed'),{randomUuid:uuids()})).reason,'request_conflict');
    const now=Math.floor(Date.now()/1000);
    await item.db.execute({sql:`INSERT INTO auth_sessions
      (session_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)`,args:[SESSION_B,1,now-1,now+3600]});
    assert.equal((await createCircleAndSelect(item.db,payload(1,SESSION_B),input(),{randomUuid:uuids()})).reason,'request_conflict');
    await item.db.execute({sql:`UPDATE auth_session_circle_contexts
      SET circle_id=1,context_version=context_version+1 WHERE session_hash=?`,args:[SESSION_A]});
    assert.equal((await createCircleAndSelect(item.db,payload(),input(),{randomUuid:uuids()})).reason,'context_changed');
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_audit_events WHERE event_type='circle.created'`)).rows[0].count),1);
  }finally{ item.close(); }
});

test('live-session, ownership, and total-membership limits fail before any new circle',async()=>{
  const item=fixture();
  try{
    await migrate(item.db); await seed(item.db);
    await item.db.execute({sql:`UPDATE auth_sessions SET revoked_at=? WHERE session_hash=?`,args:[Math.floor(Date.now()/1000),SESSION_A]});
    assert.equal((await createCircleAndSelect(item.db,payload(),input(),{randomUuid:uuids()})).reason,'session_changed');
    await item.db.execute({sql:`UPDATE auth_sessions SET revoked_at=NULL WHERE session_hash=?`,args:[SESSION_A]});
    for(let id=2;id<=MAX_OWNED_ACTIVE_CIRCLES_PER_ACCOUNT;id+=1){
      await item.db.execute({sql:`INSERT INTO circles
        (id,public_id,slug,name,is_primary,created_by) VALUES (?,?,?,?,0,1)`,args:[id,`owned-${id}`,`owned-${id}`,`Owned ${id}`]});
      await item.db.execute({sql:`INSERT INTO circle_memberships
        (circle_id,user_id,role,status) VALUES (?,1,'owner','active')`,args:[id]});
    }
    assert.equal((await createCircleAndSelect(item.db,payload(),input(),{randomUuid:uuids()})).reason,'ownership_limit');
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circles`)).rows[0].count),MAX_OWNED_ACTIVE_CIRCLES_PER_ACCOUNT);
  }finally{ item.close(); }
});

test('the total active-membership ceiling prevents creating a circle that list cannot read',async()=>{
  const item=fixture();
  try{
    await migrate(item.db); await seed(item.db);
    const statements=[];
    for(let id=2;id<=100;id+=1){
      statements.push({sql:`INSERT INTO circles
        (id,public_id,slug,name,is_primary,created_by) VALUES (?,?,?,?,0,1)`,
      args:[id,`joined-${id}`,`joined-${id}`,`Joined ${id}`]});
      statements.push({sql:`INSERT INTO circle_memberships
        (circle_id,user_id,role,status) VALUES (?,1,'member','active')`,args:[id]});
    }
    await item.db.batch(statements,'write');
    const result=await createCircleAndSelect(item.db,payload(),input(),{randomUuid:uuids()});
    assert.equal(result.reason,'membership_limit');
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circles`)).rows[0].count),100);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_creation_requests`)).rows[0].count),0);
  }finally{ item.close(); }
});

test('an applied-but-throwing commit is never retried and external replay converges',async()=>{
  const item=fixture();
  try{
    await migrate(item.db); await seed(item.db);
    let transactionCount=0;
    const ambiguousDb={
      async transaction(mode){
        transactionCount+=1;
        const transaction=await item.db.transaction(mode);
        return new Proxy(transaction,{get(target,property){
          if(property==='commit') return async()=>{ await target.commit(); throw Object.assign(new Error('lost response'),{code:'SQLITE_BUSY'}); };
          const value=target[property]; return typeof value==='function'?value.bind(target):value;
        }});
      },
    };
    await assert.rejects(
      createCircleAndSelect(ambiguousDb,payload(),input(),{randomUuid:uuids(),maxAttempts:5}),
      error=>error instanceof CircleCreationError&&error.code==='CIRCLE_CREATE_COMMIT_UNKNOWN',
    );
    assert.equal(transactionCount,1);
    const replay=await createCircleAndSelect(item.db,payload(),input(),{randomUuid:uuids()});
    assert.equal(replay.created,false);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circles`)).rows[0].count),2);
  }finally{ item.close(); }
});

test('a vetted pre-commit retry revalidates the exact live session before writing',async()=>{
  const item=fixture();
  try{
    await migrate(item.db); await seed(item.db);
    let attempts=0;
    const retryingDb={
      async transaction(mode){
        attempts+=1;
        if(attempts===2){
          await item.db.execute({sql:`UPDATE auth_sessions SET revoked_at=? WHERE session_hash=?`,
            args:[Math.floor(Date.now()/1000),SESSION_A]});
        }
        const transaction=await item.db.transaction(mode);
        let injected=false;
        return new Proxy(transaction,{get(target,property){
          if(property==='execute') return async statement=>{
            if(attempts===1&&!injected
              &&String(statement?.sql||statement).includes('SELECT circle_id,context_version')){
              injected=true;
              throw Object.assign(new Error('database is locked'),{code:'SQLITE_BUSY'});
            }
            return target.execute(statement);
          };
          const value=target[property]; return typeof value==='function'?value.bind(target):value;
        }});
      },
    };
    const result=await createCircleAndSelect(retryingDb,payload(),input(),{randomUuid:uuids()});
    assert.equal(result.reason,'session_changed');
    assert.equal(attempts,2);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circles`)).rows[0].count),1);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_creation_requests`)).rows[0].count),0);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_audit_events`)).rows[0].count),0);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM auth_session_circle_contexts`)).rows[0].count),0);
  }finally{ item.close(); }
});

test('failure after each creation write rolls the whole transaction back',async()=>{
  for(const needle of ['INSERT INTO circle_memberships','INSERT INTO circle_audit_events',
    'INSERT INTO circle_creation_requests','INSERT INTO auth_session_circle_contexts']){
    const item=fixture();
    try{
      await migrate(item.db); await seed(item.db);
      const failingDb={
        async transaction(mode){
          const transaction=await item.db.transaction(mode);
          return new Proxy(transaction,{get(target,property){
            if(property==='execute') return async statement=>{
              if(String(statement?.sql||statement).includes(needle)) throw new Error(`forced ${needle}`);
              return target.execute(statement);
            };
            const value=target[property]; return typeof value==='function'?value.bind(target):value;
          }});
        },
      };
      await assert.rejects(createCircleAndSelect(failingDb,payload(),input(),{randomUuid:uuids(),maxAttempts:1}));
      assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circles`)).rows[0].count),1,needle);
      assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_creation_requests`)).rows[0].count),0,needle);
      assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_audit_events`)).rows[0].count),0,needle);
    }finally{ item.close(); }
  }
});
