import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import {
  ensureSecondaryScheduleReadiness,
  mutateSecondarySchedule,
  parseSecondaryScheduleMutation,
  readSecondarySchedule,
  SecondaryScheduleError,
  secondaryScheduleIdentity,
} from '../../api/_secondary-schedule.js';
import { ScheduleInputError } from '../../api/_schedule.js';
import {
  createSecondaryScheduleEmailHandler,
  SECONDARY_SCHEDULE_EMAIL_EVENT_VERSION,
  secondaryScheduleInstantFingerprint,
} from '../../api/_secondary-schedule-email.js';

const SESSION_HASH='f'.repeat(64);
const PARTNER_SESSION_HASH='e'.repeat(64);
const CYCLE_A='a'.repeat(64);
const CYCLE_B='b'.repeat(64);
const GENERATION_A='11111111-1111-4111-8111-111111111111';
const GENERATION_B='22222222-2222-4222-8222-222222222222';
const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const ENV_KEYS=['CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED',
  'MULTI_CIRCLE_AVAILABILITY_ENABLED','SECONDARY_CIRCLE_COORDINATION_ENABLED',
  'SECONDARY_CIRCLE_SCHEDULING_ENABLED','SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED',
  'RANDORI_LOCAL_RUNTIME','TURSO_DATABASE_URL','NODE_ENV'];
let currentDb=null;

mock.module('../../api/_db.js',{exports:{
  captureSentryException:()=>null,captureSentryMessage:()=>null,getAdminEmails:()=>new Set(),
  getClient:()=>currentDb,getJwtSecret:()=>'secondary-schedule-test-secret-at-least-32-bytes',
  initSentry:()=>{},isSentryConfigured:()=>false,verifyMutationOrigin:()=>true,
  verifyRequestAuth:req=>({
    member:{id:1,email:'one@example.test',sessionHash:SESSION_HASH},
    partner:{id:2,email:'two@example.test',sessionHash:PARTNER_SESSION_HASH},
    cross:{id:3,email:'three@example.test',sessionHash:'d'.repeat(64)},
    outsider:{id:4,email:'outsider@example.test',sessionHash:'c'.repeat(64)},
  }[req?.headers?.['x-test-auth']]||null),
}});
const {default:dataHandler}=await import('../../api/data.js');

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-secondary-schedule-'));
  const url=`file:${join(directory,'test.sqlite')}`;
  const db=createClient({url});
  return {db,url,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,migrations:EXECUTABLE_MIGRATIONS,retry:NO_RETRY});
}

async function seed(db){
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
    (1,'one@example.test','hash','One','#111111',0),
    (2,'two@example.test','hash','Two','#222222',0),
    (3,'three@example.test','hash','Three','#333333',0),
    (4,'outsider@example.test','hash','Outsider','#444444',0)`);
  await db.execute(`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES
    (20,'circle-twenty','twenty','Twenty',0,1),(21,'circle-twenty-one','twenty-one','Twenty one',0,1)`);
  await db.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES
    (20,1,'owner','active'),(20,2,'member','active'),
    (21,1,'owner','active'),(21,3,'member','active')`);
  await db.execute({sql:`INSERT INTO auth_sessions
      (session_hash,user_id,created_at,expires_at)
    VALUES (?,1,1,4102444800),(?,2,1,4102444800),(?,3,1,4102444800)`,
    args:[SESSION_HASH,PARTNER_SESSION_HASH,'d'.repeat(64)]});
  await db.execute({sql:`INSERT INTO auth_session_circle_contexts
      (session_hash,user_id,circle_id,context_version,updated_at)
    VALUES (?,1,20,7,1),(?,2,20,7,1),(?,3,21,7,1)`,
    args:[SESSION_HASH,PARTNER_SESSION_HASH,'d'.repeat(64)]});
  for(const [circle,cycle,generation] of [[20,CYCLE_A,GENERATION_A],[21,CYCLE_B,GENERATION_B]]){
    await db.execute({sql:`INSERT INTO pairing_cycles
      (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
      VALUES (?,?,?,'2026-W38','2000-01-01T00:00:00.000Z','2999-01-01T00:00:00.000Z',
        '2000-01-01T00:00:00.000Z','Europe/London','cycle_default')`,args:[`circle:${circle}`,circle,cycle]});
    const publication=await db.execute({sql:`INSERT INTO circle_pairing_publications
      (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,
       generation_token,algorithm_version,algorithm_seed,participant_count)
      VALUES (?,?,?,'2026-W38','2000-01-01T00:00:00.000Z','2999-01-01T00:00:00.000Z',
        '2000-01-01T00:00:00.000Z','Europe/London',?,'fair-seeded-v1',?,2) RETURNING id`,
    args:[`circle:${circle}`,circle,cycle,generation,`circle:${circle}:${cycle}:weekly`]});
    const publicationId=Number(publication.rows[0].id);
    const partner=circle===20?2:3;
    await db.execute({sql:`INSERT INTO circle_pairing_eligibility
      (publication_id,scope_key,circle_id,cycle_key,user_id,is_available,availability_version,
       availability_source,position,group_position,group_size,member_position)
      VALUES (?,?,?,?,1,1,0,'cycle_default',0,0,2,0),
             (?,?,?,?,?,1,0,'cycle_default',1,0,2,1)`,args:[publicationId,`circle:${circle}`,circle,cycle,
      publicationId,`circle:${circle}`,circle,cycle,partner]});
    await db.execute({sql:`INSERT INTO circle_pairing_groups
      (publication_id,scope_key,circle_id,cycle_key,position,member_count,user_a_id,
       user_b_id,user_b_available,user_b_member_position,is_solo)
      VALUES (?,?,?,?,0,2,1,?,1,1,0)`,args:[publicationId,`circle:${circle}`,circle,cycle,partner]});
  }
}

function authority(circleId=20,contextVersion=7,userId=1,sessionHash=SESSION_HASH){
  return {kind:'session',payload:{id:userId,sessionHash},userId,circleId,contextVersion,implicit:false};
}

function enableSecondaryScheduleEmail(){
  for(const key of ENV_KEYS.slice(0,6)) process.env[key]='true';
}

async function scheduleEvents(db){
  return (await db.execute(`SELECT id,event_type,event_version,idempotency_key,payload_json,
      attempt_count,max_attempts,delivery_timeout_ms FROM outbox_events
    WHERE event_type='schedule.email.requested' ORDER BY id`)).rows.map(row=>({
      id:Number(row.id),eventType:String(row.event_type),eventVersion:Number(row.event_version),
      idempotencyKey:String(row.idempotency_key),payload:JSON.parse(String(row.payload_json)),
      attemptCount:Number(row.attempt_count)+1,maxAttempts:Number(row.max_attempts),
      deliveryTimeoutMs:Number(row.delivery_timeout_ms),leaseToken:'test-lease',
      leasedUntil:'2099-01-01T00:00:00.000Z',
    }));
}

function invoke({method='GET',url='/api/schedule',query={endpoint:'schedule'},body={},
  headers={'x-test-auth':'member','x-randori-circle-context-version':'7'}}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    const responseHeaders={};
    const res={status(code){ statusCode=code; return this; },json(payload){ resolve({status:statusCode,headers:responseHeaders,body:payload}); return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },end(payload){ resolve({status:statusCode,headers:responseHeaders,body:payload}); }};
    Promise.resolve(dataHandler({method,url,query,body,headers,
      socket:{remoteAddress:'127.0.0.1'}},res)).catch(reject);
  });
}

beforeEach(()=>{
  for(const key of ENV_KEYS) delete process.env[key];
  process.env.NODE_ENV='test';
});

afterEach(()=>{
  for(const key of ENV_KEYS) delete process.env[key];
  try{ currentDb?.close?.(); }catch{}
  currentDb=null;
});

test('secondary mutation input has no client-supplied tenancy or room capability',()=>{
  const version='a'.repeat(64);
  assert.deepEqual(parseSecondaryScheduleMutation({
    action:'propose',base_version:version,instant:'2026-09-20T08:00:00+01:00',
  }),{action:'propose',baseVersion:version,instant:'2026-09-20T07:00:00.000Z'});
  assert.deepEqual(parseSecondaryScheduleMutation({action:'clear',base_version:version}),
    {action:'clear',baseVersion:version});
  for(const body of [
    {action:'clear',base_version:version,circle_id:20},
    {action:'clear',base_version:version,group_id:2},
    {action:'clear',base_version:version,room_id:'week_1_pair_2'},
    {action:'accept',base_version:version,proposal_id:'invalid'},
    {action:'constructor',base_version:version},
    {action:'__proto__',base_version:version},
    {action:'toString',base_version:version},
  ]) assert.throws(()=>parseSecondaryScheduleMutation(body),ScheduleInputError);
  assert.equal(secondaryScheduleIdentity({generationToken:GENERATION_A,groupId:2}),
    secondaryScheduleIdentity({generationToken:GENERATION_A,groupId:2}));
  assert.notEqual(secondaryScheduleIdentity({generationToken:GENERATION_A,groupId:2}),
    secondaryScheduleIdentity({generationToken:GENERATION_B,groupId:2}));
});

test('secondary schedule proposes, accepts, removes, and clears through normalized CAS state',async()=>{
  const item=fixture(); currentDb=item.db;
  try{
    await apply(item.db); await seed(item.db);
    const initial=await readSecondarySchedule(item.db,{authority:authority()});
    assert.match(initial.schedule_id,/^[a-f0-9]{64}$/);
    assert.equal(initial.dashboard_path,'/?view=dashboard');
    assert.deepEqual(initial.schedule.proposals,[]);
    const proposed=await mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'propose',baseVersion:initial.schedule.version,instant:'2026-09-20T09:00:00.000Z',
    }});
    assert.equal(proposed.conflict,false);
    assert.equal(proposed.response.schedule.proposals[0].proposed_by,'self');
    assert.equal(proposed.response.schedule.proposals[0].legacy,false);
    const partnerView=await readSecondarySchedule(item.db,{
      authority:authority(20,7,2,PARTNER_SESSION_HASH),
    });
    assert.equal(partnerView.schedule.version,proposed.response.schedule.version);
    assert.equal(partnerView.schedule.proposals[0].proposed_by,'partner');
    const proposalId=proposed.response.schedule.proposals[0].proposal_id;
    const accepted=await mutateSecondarySchedule(item.db,{
      authority:authority(20,7,2,PARTNER_SESSION_HASH),mutation:{
        action:'accept',baseVersion:partnerView.schedule.version,proposalId,
      },
    });
    assert.equal(accepted.response.schedule.agreed_time,'2026-09-20T09:00:00.000Z');
    const removed=await mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'remove',baseVersion:accepted.response.schedule.version,proposalId,
    }});
    assert.deepEqual(removed.response.schedule.proposals,[]);
    assert.equal(removed.response.schedule.agreed_time,'2026-09-20T09:00:00.000Z');
    const cleared=await mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'clear',baseVersion:removed.response.schedule.version,
    }});
    assert.equal(cleared.response.schedule.agreed_time,null);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM pair_schedules`)).rows[0].count),0);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM outbox_events`)).rows[0].count),0);
    await item.db.execute(`UPDATE circle_pair_schedules SET schedule_key='e'||substr(schedule_key,2)`);
    await assert.rejects(()=>readSecondarySchedule(item.db,{authority:authority()}),error=>
      error instanceof SecondaryScheduleError&&error.code==='SECONDARY_SCHEDULE_INTEGRITY');
  }finally{ item.close(); currentDb=null; }
});

test('successful secondary CAS writes compact v2 recipient intents and no-op or stale writes queue nothing',async()=>{
  const item=fixture(); currentDb=item.db;
  try{
    await apply(item.db); await seed(item.db); enableSecondaryScheduleEmail();
    const initial=await readSecondarySchedule(item.db,{authority:authority()});
    const instant='2098-09-20T09:00:00.000Z';
    const proposed=await mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'propose',baseVersion:initial.schedule.version,instant,
    }});
    const proposalId=proposed.response.schedule.proposals[0].proposal_id;
    let queued=await scheduleEvents(item.db);
    assert.equal(queued.length,1);
    assert.equal(queued[0].eventVersion,SECONDARY_SCHEDULE_EMAIL_EVENT_VERSION);
    assert.equal(queued[0].idempotencyKey,
      `secondary-schedule-email/v1/${proposed.response.schedule_id}/1/proposal/2`);
    assert.deepEqual(queued[0].payload,{
      schedule_id:proposed.response.schedule_id,proposal_id:proposalId,schedule_revision:1,
      actor_user_id:1,recipient_user_id:2,kind:'proposal',
      instant_fingerprint:secondaryScheduleInstantFingerprint(instant),template_version:1,
    });
    assert.equal(JSON.stringify(queued[0].payload).includes(instant),false);
    assert.doesNotMatch(JSON.stringify(queued[0].payload),/@|Twenty|circle_id|group_id|publication_id|room/i);

    const stale=await mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'clear',baseVersion:initial.schedule.version,
    }});
    assert.equal(stale.conflict,true);
    assert.equal((await scheduleEvents(item.db)).length,1);

    const accepted=await mutateSecondarySchedule(item.db,{
      authority:authority(20,7,2,PARTNER_SESSION_HASH),mutation:{
        action:'accept',baseVersion:proposed.response.schedule.version,proposalId,
      },
    });
    queued=await scheduleEvents(item.db);
    assert.deepEqual(queued.map(item=>[item.payload.kind,item.payload.recipient_user_id]),[
      ['proposal',2],['accepted',1],['accepted',2],['reminder',1],['reminder',2],
    ]);
    assert.equal(new Set(queued.map(item=>item.eventType)).size,1);
    assert.equal(queued.every(item=>item.eventVersion===2),true);
    assert.equal(queued.filter(item=>item.payload.kind==='reminder')
      .every(item=>item.payload.schedule_revision===2),true);

    const noOp=await mutateSecondarySchedule(item.db,{
      authority:authority(20,7,2,PARTNER_SESSION_HASH),mutation:{
        action:'accept',baseVersion:accepted.response.schedule.version,proposalId,
      },
    });
    assert.equal(noOp.conflict,false);
    assert.equal(noOp.response.schedule.version,accepted.response.schedule.version);
    assert.equal((await scheduleEvents(item.db)).length,5);

    const secondProposal=await mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'propose',baseVersion:noOp.response.schedule.version,instant:'2098-09-20T10:00:00.000Z',
    }});
    const secondProposalId=secondProposal.response.schedule.proposals.at(-1).proposal_id;
    const changed=await mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'accept',baseVersion:secondProposal.response.schedule.version,proposalId:secondProposalId,
    }});
    const removed=await mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'remove',baseVersion:changed.response.schedule.version,proposalId:secondProposalId,
    }});
    const beforeClear=await scheduleEvents(item.db);
    const staleReminder=beforeClear.find(item=>item.payload.kind==='reminder'
      &&item.payload.schedule_revision===4&&item.payload.recipient_user_id===2);
    const renewedReminder=beforeClear.find(item=>item.payload.kind==='reminder'
      &&item.payload.schedule_revision===5&&item.payload.recipient_user_id===2);
    let reminderSends=0;
    const reminderHandler=createSecondaryScheduleEmailHandler({
      db:item.db,origin:'https://randori.example.test',send:async()=>{
        reminderSends+=1; return {providerMessageId:'renewed-reminder'};
      },
    });
    assert.deepEqual(await reminderHandler(staleReminder),{
      status:'suppressed',reasonCode:'SCHEDULE_INVALID',
    });
    assert.deepEqual(await reminderHandler(renewedReminder),{
      status:'delivered',providerName:'email',providerMessageId:'renewed-reminder',
    });
    assert.equal(reminderSends,1);
    await mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'clear',baseVersion:removed.response.schedule.version,
    }});
    queued=await scheduleEvents(item.db);
    assert.deepEqual(queued.slice(5).map(item=>[item.payload.schedule_revision,item.payload.kind,
      item.payload.recipient_user_id]),[
      [3,'proposal',2],[3,'reminder',1],[3,'reminder',2],
      [4,'changed',1],[4,'changed',2],[4,'reminder',1],[4,'reminder',2],
      [5,'removed',2],[5,'reminder',1],[5,'reminder',2],
      [6,'cleared',1],[6,'cleared',2],
    ]);
    assert.equal(queued.filter(item=>['proposal','removed'].includes(item.payload.kind))
      .every(item=>item.payload.recipient_user_id!==item.payload.actor_user_id),true);
    assert.equal(queued.filter(item=>['accepted','changed','cleared','reminder'].includes(item.payload.kind))
      .some(item=>item.payload.recipient_user_id===item.payload.actor_user_id),true);
  }finally{ item.close(); currentDb=null; }
});

test('secondary notification failure rolls the schedule CAS back atomically',async()=>{
  const item=fixture(); currentDb=item.db;
  try{
    await apply(item.db); await seed(item.db); enableSecondaryScheduleEmail();
    const initial=await readSecondarySchedule(item.db,{authority:authority()});
    await item.db.execute(`CREATE TRIGGER reject_secondary_schedule_email BEFORE INSERT ON outbox_events
      WHEN NEW.event_version=2 BEGIN SELECT RAISE(ABORT,'forced notification failure'); END`);
    await assert.rejects(()=>mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'propose',baseVersion:initial.schedule.version,instant:'2098-09-20T09:00:00.000Z',
    }}),error=>error instanceof SecondaryScheduleError&&error.code==='SECONDARY_SCHEDULE_UNAVAILABLE');
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_pair_schedules`)).rows[0].count),0);
    assert.equal((await scheduleEvents(item.db)).length,0);
  }finally{ item.close(); currentDb=null; }
});

test('v2 dispatch resolves current data, links only to the dashboard, and suppresses stale authority',async()=>{
  const item=fixture(); currentDb=item.db;
  try{
    await apply(item.db); await seed(item.db); enableSecondaryScheduleEmail();
    const initial=await readSecondarySchedule(item.db,{authority:authority()});
    const proposed=await mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'propose',baseVersion:initial.schedule.version,instant:'2098-09-20T09:00:00.000Z',
    }});
    const queued=await scheduleEvents(item.db);
    const messages=[];
    const handler=createSecondaryScheduleEmailHandler({
      db:item.db,origin:'https://randori.example.test',send:async message=>{
        messages.push(message); return {providerName:'capture',providerMessageId:'message-1'};
      },
    });
    await item.db.execute({sql:`DELETE FROM auth_sessions WHERE session_hash=?`,args:[PARTNER_SESSION_HASH]});
    const delivered=await handler(queued[0]);
    assert.deepEqual(delivered,{status:'delivered',providerName:'capture',providerMessageId:'message-1'});
    assert.equal(messages[0].to,'two@example.test');
    assert.match(messages[0].subject,/Twenty.*One proposed/);
    assert.match(messages[0].html,/href="https:\/\/randori\.example\.test\/\?view=dashboard"/);
    assert.doesNotMatch(messages[0].html,/\/join\/|room|workspace|video|chat/i);

    await item.db.execute(`UPDATE auth_accounts SET email='current-two@example.test' WHERE id=2`);
    await item.db.execute(`UPDATE circle_pair_schedules SET revision=revision+1`);
    assert.deepEqual(await handler(queued[0]),{status:'suppressed',reasonCode:'SCHEDULE_INVALID'});
    await item.db.execute(`UPDATE circle_pair_schedules SET revision=revision-1`);
    await item.db.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=20 AND user_id=2`);
    assert.deepEqual(await handler(queued[0]),{status:'suppressed',reasonCode:'PARTICIPANT_REVOKED'});
    await item.db.execute(`UPDATE circle_memberships SET status='active' WHERE circle_id=20 AND user_id=2`);
    await item.db.execute(`INSERT INTO user_notification_prefs (user_id,email_enabled) VALUES (2,0)`);
    assert.deepEqual(await handler(queued[0]),{status:'suppressed',reasonCode:'EMAIL_DISABLED'});
    await item.db.execute(`UPDATE user_notification_prefs SET email_enabled=1 WHERE user_id=2`);
    await item.db.execute(`UPDATE circles SET archived_at='2098-01-01T00:00:00.000Z' WHERE id=20`);
    assert.deepEqual(await handler(queued[0]),{status:'suppressed',reasonCode:'SCHEDULE_INVALID'});
    await item.db.execute(`UPDATE circles SET archived_at=NULL WHERE id=20`);
    delete process.env.SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED;
    assert.deepEqual(await handler(queued[0]),{
      status:'suppressed',reasonCode:'SECONDARY_SCHEDULE_EMAIL_DISABLED',
    });
    assert.equal(messages.length,1);
    assert.equal(proposed.response.schedule.proposals.length,1);
  }finally{ item.close(); currentDb=null; }
});

test('stale versions conflict and circle switching isolates same-cycle schedules',async()=>{
  const item=fixture(); currentDb=item.db;
  try{
    await apply(item.db); await seed(item.db);
    const first=await readSecondarySchedule(item.db,{authority:authority()});
    const written=await mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'propose',baseVersion:first.schedule.version,instant:'2026-09-20T09:00:00.000Z',
    }});
    const conflict=await mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'clear',baseVersion:first.schedule.version,
    }});
    assert.equal(conflict.conflict,true);
    assert.equal(conflict.response.schedule.version,written.response.schedule.version);
    await item.db.execute({sql:`UPDATE auth_session_circle_contexts
      SET circle_id=21,context_version=8,updated_at=2 WHERE session_hash=?`,args:[SESSION_HASH]});
    await assert.rejects(()=>readSecondarySchedule(item.db,{authority:authority()}),error=>
      error instanceof SecondaryScheduleError&&error.code==='SECONDARY_SCHEDULE_CONTEXT_CHANGED');
    const second=await readSecondarySchedule(item.db,{authority:authority(21,8)});
    assert.notEqual(second.schedule_id,first.schedule_id);
    assert.deepEqual(second.schedule.proposals,[]);
  }finally{ item.close(); currentDb=null; }
});

test('membership departure and archival revoke schedule reads and writes',async()=>{
  const item=fixture(); currentDb=item.db;
  try{
    await apply(item.db); await seed(item.db);
    const initial=await readSecondarySchedule(item.db,{authority:authority()});
    await item.db.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=20 AND user_id=2`);
    await assert.rejects(()=>mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'clear',baseVersion:initial.schedule.version,
    }}),error=>error instanceof SecondaryScheduleError&&error.code==='SECONDARY_SCHEDULE_PAIR_UNAVAILABLE');
    await item.db.execute(`UPDATE circle_memberships SET status='active' WHERE circle_id=20 AND user_id=2`);
    await item.db.execute(`UPDATE circles SET archived_at='2026-09-19T00:00:00.000Z' WHERE id=20`);
    await assert.rejects(()=>readSecondarySchedule(item.db,{authority:authority()}),error=>
      error instanceof SecondaryScheduleError&&error.code==='SECONDARY_SCHEDULE_CONTEXT_CHANGED');
  }finally{ item.close(); currentDb=null; }
});

test('caller departure and session revocation invalidate transactional authority',async()=>{
  const item=fixture(); currentDb=item.db;
  try{
    await apply(item.db); await seed(item.db);
    const initial=await readSecondarySchedule(item.db,{authority:authority()});
    await item.db.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=20 AND user_id=1`);
    await assert.rejects(()=>mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'clear',baseVersion:initial.schedule.version,
    }}),error=>error instanceof SecondaryScheduleError&&error.code==='SECONDARY_SCHEDULE_CONTEXT_CHANGED');
    await item.db.execute(`UPDATE circle_memberships SET status='active' WHERE circle_id=20 AND user_id=1`);
    await item.db.execute({sql:`UPDATE auth_sessions SET revoked_at=2 WHERE session_hash=?`,args:[SESSION_HASH]});
    await assert.rejects(()=>mutateSecondarySchedule(item.db,{authority:authority(),mutation:{
      action:'clear',baseVersion:initial.schedule.version,
    }}),error=>error instanceof SecondaryScheduleError&&error.code==='SECONDARY_SCHEDULE_CONTEXT_CHANGED');
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_pair_schedules`)).rows[0].count),0);
  }finally{ item.close(); currentDb=null; }
});

test('schedule API derives secondary scope and emits no workspace or internal identifiers',async()=>{
  const item=fixture(); currentDb=item.db;
  try{
    await apply(item.db); await seed(item.db);
    process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
    process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
    process.env.MULTI_CIRCLE_AVAILABILITY_ENABLED='true';
    process.env.SECONDARY_CIRCLE_COORDINATION_ENABLED='true';
    process.env.SECONDARY_CIRCLE_SCHEDULING_ENABLED='true';
    const initial=await invoke();
    assert.equal(initial.status,200);
    assert.equal(initial.headers['cache-control'],'private, no-store');
    assert.deepEqual(Object.keys(initial.body).sort(),[
      'circle_context_version','circle_public_id','coordination_only','dashboard_path','ok',
      'schedule','schedule_id','workspace_available',
    ]);
    assert.equal(JSON.stringify(initial.body).includes('group_id'),false);
    assert.equal(JSON.stringify(initial.body).includes('room_id'),false);
    const proposed=await invoke({method:'POST',body:{
      action:'propose',base_version:initial.body.schedule.version,instant:'2026-09-20T09:00:00.000Z',
    }});
    assert.equal(proposed.status,200);
    assert.equal(proposed.body.schedule.proposals.length,1);
    assert.equal(proposed.body.schedule.proposals[0].proposed_by,'self');
    for(const internalName of ['publication_id','group_id','user_a_id','user_b_id','proposed_by":1']){
      assert.equal(JSON.stringify(proposed.body).includes(internalName),false);
    }
    const forged=await invoke({method:'POST',body:{
      action:'clear',base_version:proposed.body.schedule.version,circle_id:21,
    }});
    assert.equal(forged.status,400);
    const queried=await invoke({url:'/api/schedule?room_id=week_1_pair_1',
      query:{endpoint:'schedule',room_id:'week_1_pair_1'}});
    assert.equal(queried.status,400);

    const before=await item.db.execute(`SELECT revision FROM circle_pair_schedules`);
    const crossHeaders={'x-test-auth':'cross','x-randori-circle-context-version':'7'};
    const crossRead=await invoke({headers:crossHeaders});
    assert.equal(crossRead.status,200);
    assert.equal(crossRead.body.circle_public_id,'circle-twenty-one');
    assert.notEqual(crossRead.body.schedule_id,initial.body.schedule_id);
    assert.deepEqual(crossRead.body.schedule.proposals,[]);
    const crossForgery=await invoke({method:'POST',headers:crossHeaders,body:{
      action:'clear',base_version:crossRead.body.schedule.version,circle_id:20,
    }});
    assert.equal(crossForgery.status,400);
    for(const method of ['GET','POST']){
      const body=method==='POST'?{action:'clear',base_version:'a'.repeat(64)}:undefined;
      assert.equal((await invoke({method,headers:{'x-test-auth':'outsider'},body})).status,403);
      assert.equal((await invoke({method,headers:{},body})).status,401);
    }
    const after=await item.db.execute(`SELECT revision FROM circle_pair_schedules`);
    assert.deepEqual(after.rows,before.rows);
  }finally{ item.close(); currentDb=null; }
});

test('secondary schema readiness is shared by repeated polls on one database client',async()=>{
  const item=fixture();
  try{
    await apply(item.db);
    let reads=0;
    const traced={
      async execute(statement){ reads+=1; return item.db.execute(statement); },
    };
    await ensureSecondaryScheduleReadiness(traced);
    const afterFirst=reads;
    assert.equal(afterFirst>0,true);
    await ensureSecondaryScheduleReadiness(traced);
    assert.equal(reads,afterFirst);
  }finally{ item.close(); }
});

test('concurrent secondary writers produce one winner and one latest-state conflict',async()=>{
  const item=fixture(); currentDb=item.db;
  const second=createClient({url:item.url});
  try{
    await apply(item.db); await seed(item.db); await prepareMigrationConnection(second);
    enableSecondaryScheduleEmail();
    const initial=await readSecondarySchedule(item.db,{authority:authority()});
    const writes=[item.db,second].map((db,index)=>mutateSecondarySchedule(db,{authority:authority(),mutation:{
      action:'propose',baseVersion:initial.schedule.version,
      instant:`2026-09-20T0${index+8}:00:00.000Z`,
    }}));
    const results=await Promise.all(writes);
    assert.deepEqual(results.map(result=>result.conflict).sort(),[false,true]);
    const winner=results.find(result=>!result.conflict).response;
    const loser=results.find(result=>result.conflict).response;
    assert.deepEqual(loser.schedule,winner.schedule);
    assert.equal(winner.schedule.proposals.length,1);
    assert.equal((await scheduleEvents(item.db)).length,1);
  }finally{ second.close(); item.close(); currentDb=null; }
});

test('an applied-but-throwing commit is not replayed',async()=>{
  const item=fixture(); currentDb=item.db;
  try{
    await apply(item.db); await seed(item.db); enableSecondaryScheduleEmail();
    const initial=await readSecondarySchedule(item.db,{authority:authority()});
    let transactionCount=0;
    const ambiguous={
      execute:statement=>item.db.execute(statement),
      batch:(statements,mode)=>item.db.batch(statements,mode),
      async transaction(mode){
        transactionCount+=1;
        const transaction=await item.db.transaction(mode);
        return {
          execute:statement=>transaction.execute(statement),
          batch:(statements,batchMode)=>transaction.batch(statements,batchMode),
          async commit(){ await transaction.commit(); throw new Error('ambiguous transport after commit'); },
          rollback:()=>transaction.rollback(),close:()=>transaction.close(),
        };
      },
    };
    await assert.rejects(()=>mutateSecondarySchedule(ambiguous,{authority:authority(),mutation:{
      action:'propose',baseVersion:initial.schedule.version,instant:'2026-09-20T08:00:00.000Z',
    }}),error=>error instanceof SecondaryScheduleError&&error.code==='SECONDARY_SCHEDULE_UNAVAILABLE');
    assert.equal(transactionCount,1);
    const stored=await readSecondarySchedule(item.db,{authority:authority()});
    assert.equal(stored.schedule.proposals.length,1);
    assert.equal(Number((await item.db.execute(`SELECT revision FROM circle_pair_schedules`)).rows[0].revision),1);
    assert.equal((await scheduleEvents(item.db)).length,1);
  }finally{ item.close(); currentDb=null; }
});

test('flag-on selected-primary schedule keeps the canonical room API contract',async()=>{
  const item=fixture(); currentDb=item.db;
  try{
    await apply(item.db); await seed(item.db);
    process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
    process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
    process.env.MULTI_CIRCLE_AVAILABILITY_ENABLED='true';
    process.env.SECONDARY_CIRCLE_COORDINATION_ENABLED='true';
    process.env.SECONDARY_CIRCLE_SCHEDULING_ENABLED='true';
    await item.db.execute(`INSERT INTO circles
      (id,public_id,slug,name,is_primary,created_by) VALUES (10,'circle-primary','primary','Primary',1,1)`);
    await item.db.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status)
      VALUES (10,1,'owner','active'),(10,2,'member','active')`);
    await item.db.execute(`INSERT INTO pairing_weeks
      (id,week_label,week_start,focus,is_demo) VALUES (42,'2026-W42','2026-09-19','both',0)`);
    await item.db.execute(`INSERT INTO pairing_groups
      (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (7,42,1,2,NULL,0)`);
    await item.db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source)
      VALUES (42,1,0,'auth'),(42,2,1,'auth')`);
    await item.db.execute({sql:`UPDATE auth_session_circle_contexts
      SET circle_id=10,context_version=12,updated_at=2 WHERE session_hash=?`,args:[SESSION_HASH]});
    const headers={'x-test-auth':'member','x-randori-circle-context-version':'12'};
    const initial=await invoke({url:'/api/schedule?room_id=week_42_pair_7',
      query:{endpoint:'schedule',room_id:'week_42_pair_7'},headers});
    assert.equal(initial.status,200);
    assert.equal(initial.body.room_id,'week_42_pair_7');
    assert.equal('schedule_id' in initial.body,false);
    const cleared=await invoke({method:'POST',headers,body:{room_id:'week_42_pair_7',
      action:'clear',base_version:initial.body.schedule.version}});
    assert.equal(cleared.status,200);
    assert.equal(cleared.body.room_id,'week_42_pair_7');
    assert.equal('coordination_only' in cleared.body,false);
  }finally{ item.close(); currentDb=null; }
});
