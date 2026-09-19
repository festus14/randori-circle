import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import { readScheduleState, projectSchedule } from '../../api/_schedule.js';
import {
  createScheduleEmailHandler,
  deliverScheduleEmails,
  scheduleNotificationEvents,
  SCHEDULE_EMAIL_EVENT_TYPE,
  SCHEDULE_EMAIL_EVENT_VERSION,
  SCHEDULE_EMAIL_TEMPLATE_VERSION,
  SCHEDULE_REMINDER_LEAD_MS,
} from '../../api/_schedule-email.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const cleanup=[];

afterEach(async()=>{
  while(cleanup.length){ try{ await cleanup.pop()(); }catch{} }
});

async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-schedule-email-'));
  const db=createClient({url:`file:${join(directory,'schedule.sqlite')}`});
  await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:initial.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  await db.batch([
    {sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo)
      VALUES (1,'alice@example.test','hash','Alice <Admin>','#111',0)`,args:[]},
    {sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo)
      VALUES (2,'bob@example.test','hash','Bob','#222',0)`,args:[]},
    {sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo)
      VALUES (3,'demo@example.test','hash','Demo','#333',1)`,args:[]},
    {sql:`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by)
      VALUES (1,'circle_public','randori-circle','Randori',1,1)`,args:[]},
    {sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by)
      VALUES (1,1,'owner','active',1),(1,2,'member','active',1)`,args:[]},
    {sql:`INSERT INTO pairing_weeks (id,week_label,week_start,focus,is_demo)
      VALUES (10,'2035-W38','2035-09-16','both',0)`,args:[]},
    {sql:`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair)
      VALUES (20,10,1,2,NULL,0)`,args:[]},
    {sql:`INSERT INTO pairing_participants (week_id,user_id,position,source)
      VALUES (10,1,0,'auth'),(10,2,1,'auth')`,args:[]},
  ],'write');
  cleanup.push(async()=>{ await db.close(); rmSync(directory,{recursive:true,force:true}); });
  return db;
}

function schedule({proposals=[],agreedTime=null,updatedAt='2035-09-18T10:00:00.000Z'}={}){
  return projectSchedule(readScheduleState({
    proposed_times:JSON.stringify(proposals),agreed_time:agreedTime,updated_at:updatedAt,
  }));
}

async function storeSchedule(db,value){
  await db.execute({sql:`INSERT INTO pair_schedules
      (week_id,pair_group_id,proposed_times,agreed_time,created_at,updated_at)
    VALUES (10,20,?,?,?,?)
    ON CONFLICT(week_id,pair_group_id) DO UPDATE SET
      proposed_times=excluded.proposed_times,agreed_time=excluded.agreed_time,updated_at=excluded.updated_at`,
  args:[JSON.stringify(value.proposals||[]),value.agreedTime||null,value.updatedAt,value.updatedAt]});
}

function contexts(){
  const instant='2035-09-20T18:30:00.000Z';
  const entry={instant,proposed_by:1};
  return {
    instant,entry,
    empty:schedule({updatedAt:'2035-09-18T10:00:00.000Z'}),
    proposed:schedule({proposals:[entry],updatedAt:'2035-09-18T10:00:01.000Z'}),
    accepted:schedule({proposals:[entry],agreedTime:instant,updatedAt:'2035-09-18T10:00:02.000Z'}),
    changed:schedule({proposals:[entry,{instant:'2035-09-21T19:00:00.000Z',proposed_by:2}],
      agreedTime:'2035-09-21T19:00:00.000Z',updatedAt:'2035-09-18T10:00:03.000Z'}),
  };
}

test('schedule intents are versioned, recipient-minimal, deduplicated, and reminder-delayed',async()=>{
  const db=await fixture();
  const state=contexts();
  const proposal=scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:1,
    participants:[1,2,null],mutation:{action:'propose',instant:state.instant},
    currentSchedule:state.empty,nextSchedule:state.proposed});
  assert.equal(proposal.length,1,'the proposer is not emailed their own proposal');
  const proposedPayload=JSON.parse(proposal[0].args[3]);
  assert.deepEqual(proposedPayload,{
    kind:'proposal',week_id:10,pair_group_id:20,actor_user_id:1,recipient_user_id:2,
    schedule_version:state.proposed.version,template_version:SCHEDULE_EMAIL_TEMPLATE_VERSION,
    instant:state.instant,previous_instant:null,
  });
  assert.equal(JSON.stringify(proposedPayload).includes('@'),false,'outbox payload stores no address');
  assert.equal(proposal[0].args[0],SCHEDULE_EMAIL_EVENT_TYPE);
  assert.equal(proposal[0].args[1],SCHEDULE_EMAIL_EVENT_VERSION);

  const accepted=scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:2,
    participants:[1,2,2],mutation:{action:'accept'},currentSchedule:state.proposed,nextSchedule:state.accepted});
  assert.equal(accepted.length,4,'acceptance and reminder reach each distinct participant');
  const payloads=accepted.map(statement=>JSON.parse(statement.args[3]));
  assert.deepEqual(payloads.map(payload=>payload.kind),['accepted','reminder','accepted','reminder']);
  assert.equal(accepted[1].args[4],new Date(Date.parse(state.instant)-SCHEDULE_REMINDER_LEAD_MS).toISOString());
  await db.batch(accepted,'write');
  await db.batch(accepted,'write');
  const stored=await db.execute(`SELECT event_type,event_version,idempotency_key,payload_json,max_attempts,
    delivery_timeout_ms FROM outbox_events ORDER BY id`);
  assert.equal(stored.rows.length,4,'provider retries or duplicate API work cannot duplicate intent');
  assert.ok(stored.rows.every(row=>Number(row.max_attempts)===5&&Number(row.delivery_timeout_ms)===10_000));
  assert.equal(JSON.stringify(stored.rows).includes('alice@example.test'),false);

  const changed=scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:1,
    participants:[1,2],mutation:{action:'accept'},currentSchedule:state.accepted,nextSchedule:state.changed});
  assert.deepEqual(changed.map(statement=>JSON.parse(statement.args[3]).kind),
    ['changed','reminder','changed','reminder']);
  assert.equal(JSON.parse(changed[0].args[3]).previous_instant,state.instant);

  const cleared=schedule({proposals:[state.entry],agreedTime:null,updatedAt:'2035-09-18T10:00:04.000Z'});
  assert.equal(scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:2,
    participants:[1,2],mutation:{action:'clear'},currentSchedule:state.accepted,nextSchedule:cleared}).length,2);
  assert.deepEqual(scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:2,
    participants:[1,2],mutation:{action:'remove'},currentSchedule:state.proposed,nextSchedule:state.empty}),[]);
  assert.deepEqual(scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:2,
    participants:[1,2],mutation:{action:'accept'},currentSchedule:state.accepted,nextSchedule:state.accepted}),[]);
});

test('delivery rechecks schedule, preference, recipient, and active membership without leaking payload PII',async()=>{
  const db=await fixture();
  const state=contexts();
  await storeSchedule(db,{proposals:[state.entry],agreedTime:state.instant,
    updatedAt:'2035-09-18T10:00:02.000Z'});
  const statements=scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:2,
    participants:[1,2],mutation:{action:'accept'},currentSchedule:state.proposed,nextSchedule:state.accepted});
  // Immediate acceptance events are due now; reminders remain scheduled for 2035.
  await db.batch(statements,'write');
  const messages=[];
  const delivered=await deliverScheduleEmails({db,baseUrl:'https://randori.example.test',
    send:async message=>{ messages.push(message); return {providerName:'capture',providerMessageId:`msg-${messages.length}`}; },
    workerId:'schedule-test',workerOptions:{heartbeatIntervalMs:0,leaseDurationMs:1000}});
  assert.equal(delivered.delivered,2);
  assert.equal(messages.length,2);
  assert.deepEqual(messages.map(message=>message.to).sort(),['alice@example.test','bob@example.test']);
  assert.ok(messages.every(message=>message.subject==='Your Randori session is scheduled'));
  assert.ok(messages.every(message=>message.html.includes('/join/week_10_pair_20')));
  assert.ok(messages.every(message=>message.html.includes('&lt;Admin&gt;')===false),
    'acceptance copy does not need the actor name');
  assert.ok(messages.every(message=>!message.idempotencyKey.includes('@')));

  await db.execute(`UPDATE user_notification_prefs SET email_enabled=0 WHERE user_id=2`);
  await db.execute(`INSERT INTO user_notification_prefs (user_id,email_enabled) VALUES (2,0)
    ON CONFLICT(user_id) DO UPDATE SET email_enabled=0`);
  const changed=schedule({proposals:[state.entry],agreedTime:null,updatedAt:'2035-09-18T10:00:04.000Z'});
  await storeSchedule(db,{proposals:[state.entry],agreedTime:null,updatedAt:'2035-09-18T10:00:04.000Z'});
  await db.batch(scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:2,
    participants:[1,2],mutation:{action:'clear'},currentSchedule:state.accepted,nextSchedule:changed}),'write');
  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE user_id=1`);
  const suppressed=await deliverScheduleEmails({db,baseUrl:'https://randori.example.test',
    send:async()=>assert.fail('suppressed work must not reach the provider'),workerId:'suppress-test',
    workerOptions:{heartbeatIntervalMs:0,leaseDurationMs:1000}});
  assert.equal(suppressed.suppressed,2);
  const reasons=(await db.execute(`SELECT last_error_code FROM outbox_events
    WHERE status='suppressed' ORDER BY id`)).rows.map(row=>row.last_error_code);
  assert.deepEqual(reasons,['PARTICIPANT_REVOKED','EMAIL_DISABLED']);
  assert.equal(JSON.stringify({suppressed,reasons}).includes('@'),false);

  await db.execute(`UPDATE circle_memberships SET status='active' WHERE user_id=1`);
  await db.execute(`UPDATE user_notification_prefs SET email_enabled=1 WHERE user_id=2`);
  const newInstant='2035-09-22T10:00:00.000Z';
  const newProposal=schedule({proposals:[{instant:newInstant,proposed_by:1}],
    agreedTime:null,updatedAt:'2035-09-18T10:00:05.000Z'});
  await storeSchedule(db,{proposals:[{instant:newInstant,proposed_by:1}],agreedTime:null,
    updatedAt:'2035-09-18T10:00:05.000Z'});
  await db.execute(scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:1,
    participants:[1,2],mutation:{action:'propose',instant:newInstant},
    currentSchedule:changed,nextSchedule:newProposal})[0]);
  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE user_id=1`);
  const actorRevoked=await deliverScheduleEmails({db,baseUrl:'https://randori.example.test',
    send:async()=>assert.fail('revoked actor work must not reach the provider'),workerId:'actor-revoked',
    workerOptions:{heartbeatIntervalMs:0,leaseDurationMs:1000}});
  assert.equal(actorRevoked.suppressed,1);
  const actorReason=(await db.execute(`SELECT last_error_code FROM outbox_events
    WHERE id=(SELECT MAX(id) FROM outbox_events)`)).rows[0].last_error_code;
  assert.equal(actorReason,'PARTICIPANT_REVOKED');
});

test('stale, rescheduled, removed, cancelled, and elapsed events suppress before provider delivery',async()=>{
  const db=await fixture();
  const state=contexts();
  const sender=async()=>assert.fail('stale work must not reach provider');

  const proposalStatements=scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:1,
    participants:[1,2],mutation:{action:'propose',instant:state.instant},
    currentSchedule:state.empty,nextSchedule:state.proposed});
  await db.execute(proposalStatements[0]);
  await storeSchedule(db,{proposals:[],agreedTime:null,updatedAt:'2035-09-18T11:00:00.000Z'});
  let result=await deliverScheduleEmails({db,baseUrl:'https://randori.example.test',send:sender,
    workerId:'stale-proposal',localRuntime:true,workerOptions:{heartbeatIntervalMs:0,leaseDurationMs:1000}});
  assert.equal(result.suppressed,1);

  await db.batch(scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:2,
    participants:[1,2],mutation:{action:'accept'},currentSchedule:state.proposed,nextSchedule:state.accepted}),'write');
  await storeSchedule(db,{proposals:[state.entry],agreedTime:state.changed.agreed_time,
    updatedAt:'2035-09-18T12:00:00.000Z'});
  await db.execute(`UPDATE outbox_events SET not_before=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='pending'`);
  result=await deliverScheduleEmails({db,baseUrl:'https://randori.example.test',send:sender,
    workerId:'stale-acceptance',localRuntime:true,workerOptions:{heartbeatIntervalMs:0,leaseDurationMs:1000}});
  assert.equal(result.suppressed,4,'rescheduling suppresses both old confirmations and reminders');

  const past='2020-09-20T18:30:00.000Z';
  const pastEntry={instant:past,proposed_by:1};
  const pastCurrent=schedule({proposals:[pastEntry],updatedAt:'2020-09-18T10:00:00.000Z'});
  const pastAccepted=schedule({proposals:[pastEntry],agreedTime:past,updatedAt:'2020-09-18T10:00:01.000Z'});
  await storeSchedule(db,{proposals:[pastEntry],agreedTime:past,updatedAt:'2020-09-18T10:00:01.000Z'});
  await db.batch(scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:2,
    participants:[1,2],mutation:{action:'accept'},currentSchedule:pastCurrent,nextSchedule:pastAccepted}),'write');
  result=await deliverScheduleEmails({db,baseUrl:'https://randori.example.test',send:sender,
    workerId:'elapsed',localRuntime:true,workerOptions:{heartbeatIntervalMs:0,leaseDurationMs:1000}});
  assert.equal(result.suppressed,4);
  const elapsed=await db.execute(`SELECT COUNT(*) AS count FROM outbox_events
    WHERE status='suppressed' AND last_error_code='SESSION_ELAPSED'`);
  assert.equal(Number(elapsed.rows[0].count),4);
});

test('accepted proposal emails are suppressed before drain, including a reschedule',async()=>{
  const db=await fixture();
  const state=contexts();
  await db.execute(scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:1,
    participants:[1,2],mutation:{action:'propose',instant:state.instant},
    currentSchedule:state.empty,nextSchedule:state.proposed})[0]);
  await db.batch(scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:2,
    participants:[1,2],mutation:{action:'accept'},currentSchedule:state.proposed,
    nextSchedule:state.accepted}),'write');
  await storeSchedule(db,{proposals:[state.entry],agreedTime:state.instant,
    updatedAt:'2035-09-18T10:00:02.000Z'});
  const messages=[];
  let result=await deliverScheduleEmails({db,baseUrl:'https://randori.example.test',
    send:async message=>{ messages.push(message); return {providerMessageId:`accepted-${messages.length}`}; },
    workerId:'accept-before-drain',localRuntime:true,
    workerOptions:{heartbeatIntervalMs:0,leaseDurationMs:1000}});
  assert.equal(result.delivered,2);
  assert.equal(result.suppressed,1);
  assert.deepEqual(messages.map(message=>message.subject),[
    'Your Randori session is scheduled','Your Randori session is scheduled',
  ]);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM outbox_events
    WHERE status='suppressed' AND last_error_code='SCHEDULE_SUPERSEDED'`)).rows[0].count),1);

  const instantB='2035-09-21T19:00:00.000Z';
  const entryB={instant:instantB,proposed_by:2};
  const proposedB=schedule({proposals:[state.entry,entryB],agreedTime:state.instant,
    updatedAt:'2035-09-18T10:00:03.000Z'});
  const acceptedB=schedule({proposals:[state.entry,entryB],agreedTime:instantB,
    updatedAt:'2035-09-18T10:00:04.000Z'});
  await db.execute(scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:2,
    participants:[1,2],mutation:{action:'propose',instant:instantB},
    currentSchedule:state.accepted,nextSchedule:proposedB})[0]);
  await db.batch(scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:1,
    participants:[1,2],mutation:{action:'accept'},currentSchedule:proposedB,
    nextSchedule:acceptedB}),'write');
  await storeSchedule(db,{proposals:[state.entry,entryB],agreedTime:instantB,
    updatedAt:'2035-09-18T10:00:04.000Z'});
  const rescheduled=[];
  result=await deliverScheduleEmails({db,baseUrl:'https://randori.example.test',
    send:async message=>{ rescheduled.push(message); return {providerMessageId:`changed-${rescheduled.length}`}; },
    workerId:'reschedule-before-drain',localRuntime:true,
    workerOptions:{heartbeatIntervalMs:0,leaseDurationMs:1000}});
  assert.equal(result.delivered,2);
  assert.equal(result.suppressed,1);
  assert.deepEqual(rescheduled.map(message=>message.subject),[
    'Your Randori session time changed','Your Randori session time changed',
  ]);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM outbox_events
    WHERE status='suppressed' AND last_error_code='SCHEDULE_SUPERSEDED'`)).rows[0].count),2);
});

test('an A-to-B-to-A reschedule delivers only the newest confirmation and reminder',async()=>{
  const db=await fixture();
  const instantA='2035-09-20T18:30:00.000Z';
  const instantB='2035-09-21T19:00:00.000Z';
  const entryA={instant:instantA,proposed_by:1};
  const entryB={instant:instantB,proposed_by:2};
  const proposed=schedule({proposals:[entryA,entryB],updatedAt:'2035-09-18T10:00:00.000Z'});
  const acceptedA=schedule({proposals:[entryA,entryB],agreedTime:instantA,updatedAt:'2035-09-18T10:01:00.000Z'});
  const acceptedB=schedule({proposals:[entryA,entryB],agreedTime:instantB,updatedAt:'2035-09-18T10:02:00.000Z'});
  const returnedA=schedule({proposals:[entryA,entryB],agreedTime:instantA,updatedAt:'2035-09-18T10:03:00.000Z'});
  const all=[
    ...scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:2,participants:[1,2],
      mutation:{action:'accept'},currentSchedule:proposed,nextSchedule:acceptedA}),
    ...scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:1,participants:[1,2],
      mutation:{action:'accept'},currentSchedule:acceptedA,nextSchedule:acceptedB}),
    ...scheduleNotificationEvents({weekId:10,pairGroupId:20,actorUserId:2,participants:[1,2],
      mutation:{action:'accept'},currentSchedule:acceptedB,nextSchedule:returnedA}),
  ];
  await db.batch(all,'write');
  await storeSchedule(db,{proposals:[entryA,entryB],agreedTime:instantA,
    updatedAt:'2035-09-18T10:03:00.000Z'});
  await db.execute(`UPDATE outbox_events SET not_before=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  const messages=[];
  const result=await deliverScheduleEmails({db,baseUrl:'https://randori.example.test',
    send:async message=>{ messages.push(message); return {providerMessageId:`latest-${messages.length}`}; },
    workerId:'reschedule-cycle',localRuntime:true,
    workerOptions:{heartbeatIntervalMs:0,leaseDurationMs:1000}});
  assert.equal(result.delivered,4);
  assert.equal(result.suppressed,8);
  assert.deepEqual(messages.map(message=>message.subject).sort(),[
    'Reminder: your Randori session is coming up','Reminder: your Randori session is coming up',
    'Your Randori session time changed','Your Randori session time changed',
  ].sort());
});

test('handler rejects unsupported versions and malformed payloads as permanent failures',async()=>{
  const db=await fixture();
  const handler=createScheduleEmailHandler({db,baseUrl:'https://randori.example.test',send:async()=>({})});
  await assert.rejects(()=>handler({eventVersion:3,payload:{}}),error=>
    error?.code==='EVENT_VERSION_UNSUPPORTED'&&error?.retryable===false);
  await assert.rejects(()=>handler({eventVersion:2,payload:{recipient_email:'leak@example.test'}}),error=>
    error?.code==='PAYLOAD_INVALID'&&error?.retryable===false);
  await assert.rejects(()=>handler({eventVersion:1,payload:{kind:'proposal'}}),error=>
    error?.code==='PAYLOAD_INVALID'&&error?.retryable===false);
  assert.throws(()=>createScheduleEmailHandler({db,baseUrl:'not a URL',send:async()=>({})}),/base URL/);
});
