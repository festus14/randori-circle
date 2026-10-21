// Issue #287 reminders: cycle-boundary timing, idempotent enqueue, send-time
// suppression, recipient timezone display, secondary circles, and provider
// error classification, against a real migrated SQLite database.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import { availabilityCycleKey } from '../../api/_availability.js';
import { OutboxDeliveryError, replayDeadLetter, runOutboxWorker } from '../../api/_outbox.js';
import { resolvePairingCycle } from '../../api/_pairing-cycle.js';
import {
  AGREE_TIME_NUDGE_DELAY_MS,
  AVAILABILITY_CUTOFF_LEAD_MS,
  createReminderEmailHandler,
  enqueueDueReminders,
  formatReminderInstant,
  REMINDER_EMAIL_EVENT_TYPE,
  REMINDER_EMAIL_EVENT_VERSION,
  reminderEventStatement,
  reminderInstantFingerprint,
  reminderPreferenceDescriptor,
  remindersEnabled,
  renderReminderEmail,
  SESSION_SOON_LEAD_MS,
  SESSION_SOON_MIN_LEAD_MS,
  sessionSoonRemindersEnabled,
} from '../../api/_reminders.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const ZONE='Europe/London';
// Thursday of ISO week 2098-W38; the cycle started Sunday 2098-09-14 08:00 BST.
const THURSDAY='2098-09-18T12:00:00.000Z';
const W38_START='2098-09-14T07:00:00.000Z';
// The next cutoff is Sunday 2098-09-21 08:00 BST (07:00Z).
const CUTOFF='2098-09-21T07:00:00.000Z';
const ORIGIN='https://randori.example.test';
const FLAGS=['REMINDERS_ENABLED','REMINDERS_SESSION_SOON_ENABLED','PAIRING_TIME_ZONE','CIRCLE_MEMBERSHIP_ENABLED',
  'MULTI_CIRCLE_CONTROL_PLANE_ENABLED','MULTI_CIRCLE_AVAILABILITY_ENABLED','SECONDARY_CIRCLE_COORDINATION_ENABLED',
  'SECONDARY_CIRCLE_SCHEDULING_ENABLED'];
const SECONDARY_FLAGS=FLAGS.slice(3);
const previous=Object.fromEntries(FLAGS.map(key=>[key,process.env[key]]));
const cleanup=[];

beforeEach(()=>{
  for(const key of FLAGS) delete process.env[key];
  process.env.REMINDERS_ENABLED='true';
  process.env.PAIRING_TIME_ZONE=ZONE;
});

afterEach(async()=>{
  while(cleanup.length){ try{ await cleanup.pop()(); }catch{} }
  for(const [key,value] of Object.entries(previous)){
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
});

function enableSecondary(){ for(const key of SECONDARY_FLAGS) process.env[key]='true'; }
const at=value=>()=>new Date(value);
const plus=(iso,ms)=>new Date(Date.parse(iso)+ms).toISOString();

async function fixture(){
  const {directory,url}=await createMigratedDatabase({prefix:'randori-reminders-',filename:'reminders.sqlite'});
  const db=createClient({url});
  await prepareMigrationConnection(db);
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo,tz) VALUES
      (1,'alice@example.test','hash','Alice','#111',0,'Europe/London'),
      (2,'bob@example.test','hash','Bob','#222',0,'America/New_York'),
      (3,'demo@example.test','hash','Demo','#333',1,NULL),
      (4,'carol@example.test','hash','Carol','#444',0,'Mars/Olympus')`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES
      (1,'circle_public','randori','Randori',1,1),(20,'circle-twenty','twenty','Night <Owls>',0,1)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES
      (1,1,'owner','active'),(1,2,'member','active'),(1,3,'member','active'),(1,4,'member','active'),
      (20,1,'owner','active'),(20,2,'member','active')`,
  ],'write');
  cleanup.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  return db;
}

async function seedPrimaryWeek(db,{cycleId='2098-W38',startsAt=W38_START,pairedAt='2098-09-14 07:00:00',
  pairs=[[1,2]],weekId=10,ai=false}={}){
  await db.execute({sql:`INSERT INTO pairing_weeks (id,week_label,week_start,focus,is_demo) VALUES (?,?,?,'both',0)`,
    args:[weekId,cycleId,startsAt]});
  await db.execute({sql:`INSERT INTO pairing_week_runs (week_label,week_id,generation_token,generation,
      algorithm_version,algorithm_seed,participant_count,participants_json,created_at)
    VALUES (?,?,?,1,'fair-v1','seed',?,'[]',?)`,args:[cycleId,weekId,`token-${weekId}`,pairs.flat().length,pairedAt]});
  const users=[...new Set(pairs.flat())];
  for(const [position,userId] of users.entries()){
    await db.execute({sql:`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (?,?,?,'auth')`,
      args:[weekId,userId,position]});
  }
  const groups=[];
  for(const [a,b,c] of pairs){
    const inserted=await db.execute({sql:`INSERT INTO pairing_groups (week_id,user_a_id,user_b_id,user_c_id,is_ai_pair)
      VALUES (?,?,?,?,?) RETURNING id`,args:[weekId,a,b??a,c??null,ai?1:0]});
    groups.push(Number(inserted.rows[0].id));
  }
  return {weekId,groups};
}

async function agree(db,weekId,groupId,agreedTime){
  await db.execute({sql:`INSERT INTO pair_schedules (week_id,pair_group_id,proposed_times,agreed_time)
      VALUES (?,?,'[]',?) ON CONFLICT(week_id,pair_group_id) DO UPDATE SET agreed_time=excluded.agreed_time`,
  args:[weekId,groupId,agreedTime]});
}

async function seedCycle(db,circleId,cycle){
  const key=availabilityCycleKey({kind:'circle',circleId},cycle);
  await db.execute({sql:`INSERT INTO pairing_cycles
      (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
    VALUES (?,?,?,?,?,?,?,?,'cycle_default') ON CONFLICT DO NOTHING`,
  args:[`circle:${circleId}`,circleId,key,cycle.cycleId,cycle.startsAt,cycle.endsAt,cycle.cutoffAt,cycle.timeZone]});
  return key;
}

async function decide(db,circleId,cycle,userId,source='user'){
  const key=await seedCycle(db,circleId,cycle);
  await db.execute({sql:`INSERT INTO pairing_cycle_availability
      (scope_key,cycle_key,user_id,is_available,version,decision_source) VALUES (?,?,?,0,1,?)`,
  args:[`circle:${circleId}`,key,userId,source]});
}

async function seedSecondary(db,{now=THURSDAY,createdAt='2098-09-14T07:00:00.000Z',agreedTime=null}={}){
  const cycle=resolvePairingCycle({now:new Date(now),timeZone:ZONE,state:'current'});
  const key=await seedCycle(db,20,cycle);
  const publication=await db.execute({sql:`INSERT INTO circle_pairing_publications
      (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,
       generation_token,algorithm_version,algorithm_seed,participant_count,created_at)
    VALUES ('circle:20',20,?,?,?,?,?,?,'11111111-1111-4111-8111-111111111111','fair-seeded-v1',?,2,?) RETURNING id`,
  args:[key,cycle.cycleId,cycle.startsAt,cycle.endsAt,cycle.cutoffAt,cycle.timeZone,`circle:20:${key}:weekly`,createdAt]});
  const publicationId=Number(publication.rows[0].id);
  await db.execute({sql:`INSERT INTO circle_pairing_eligibility
      (publication_id,scope_key,circle_id,cycle_key,user_id,is_available,availability_version,
       availability_source,position,group_position,group_size,member_position)
    VALUES (?,'circle:20',20,?,1,1,0,'cycle_default',0,0,2,0),(?,'circle:20',20,?,2,1,0,'cycle_default',1,0,2,1)`,
  args:[publicationId,key,publicationId,key]});
  const group=await db.execute({sql:`INSERT INTO circle_pairing_groups
      (publication_id,scope_key,circle_id,cycle_key,position,member_count,user_a_id,
       user_b_id,user_b_available,user_b_member_position,is_solo)
    VALUES (?,'circle:20',20,?,0,2,1,2,1,1,0) RETURNING id`,args:[publicationId,key]});
  const groupId=Number(group.rows[0].id);
  let scheduleId=null;
  if(agreedTime!==undefined){
    const schedule=await db.execute({sql:`INSERT INTO circle_pair_schedules
        (schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,member_count,
         user_a_id,user_b_id,is_solo,revision,agreed_time,created_at,updated_at)
      VALUES (?,?,'circle:20',20,?,?,2,1,2,0,1,?,?,?) RETURNING id`,
    args:['c'.repeat(64),publicationId,key,groupId,agreedTime,createdAt,createdAt]});
    scheduleId=Number(schedule.rows[0].id);
  }
  return {publicationId,groupId,scheduleId};
}

async function queued(db){
  const result=await db.execute(`SELECT idempotency_key,payload_json,not_before FROM outbox_events
    WHERE event_type='${REMINDER_EMAIL_EVENT_TYPE}' ORDER BY id`);
  return result.rows.map(row=>({key:String(row.idempotency_key),payload:JSON.parse(String(row.payload_json)),
    notBefore:String(row.not_before)}));
}

function eventFrom(row,id=1){
  return {id,eventType:REMINDER_EMAIL_EVENT_TYPE,eventVersion:REMINDER_EMAIL_EVENT_VERSION,
    idempotencyKey:row.key,payload:row.payload};
}

function capture(){
  const sent=[];
  const send=async message=>{ sent.push(message); return {providerName:'capture',providerMessageId:`m-${sent.length}`}; };
  return {sent,send};
}

function handlerAt(db,now,send){
  return createReminderEmailHandler({db,baseUrl:`${ORIGIN}/ignored?path`,send,now:at(now)});
}

test('flags default off; the preference descriptor and enqueue are inert until enabled',async()=>{
  delete process.env.REMINDERS_ENABLED;
  assert.equal(remindersEnabled(),false);
  assert.equal(sessionSoonRemindersEnabled(),false);
  assert.equal(reminderPreferenceDescriptor(),null);
  const untouched={execute(){ throw new Error('no database access while disabled'); },batch(){ throw new Error('no'); }};
  assert.deepEqual(await enqueueDueReminders(untouched),
    {enabled:false,availability_cutoff:0,agree_time:0,session_soon:0,errors:{}});
  process.env.REMINDERS_SESSION_SOON_ENABLED='true';
  assert.equal(sessionSoonRemindersEnabled(),false,'the one-hour reminder needs the master flag');
  process.env.REMINDERS_ENABLED='true';
  assert.equal(sessionSoonRemindersEnabled(),true);
  assert.deepEqual(reminderPreferenceDescriptor(),{availability_cutoff:true,agree_time:true,session_soon:true,
    controlled_by:'email_enabled'});
  delete process.env.REMINDERS_SESSION_SOON_ENABLED;
  assert.equal(reminderPreferenceDescriptor().session_soon,false);
  await assert.rejects(()=>enqueueDueReminders({execute(){}}),/database client/);
  await assert.rejects(()=>enqueueDueReminders({execute(){},batch(){}},{now:'not a date'}),/clock/);
});

test('availability cutoff reminders open exactly 24 hours before the Sunday cutoff and close at it',async()=>{
  const db=await fixture();
  const before=plus(CUTOFF,-AVAILABILITY_CUTOFF_LEAD_MS-1);
  assert.equal((await enqueueDueReminders(db,{now:at(before)})).availability_cutoff,0);
  assert.equal((await enqueueDueReminders(db,{now:at(CUTOFF)})).availability_cutoff,0,'the cutoff itself is closed');
  const opened=plus(CUTOFF,-AVAILABILITY_CUTOFF_LEAD_MS);
  const cycle=resolvePairingCycle({now:new Date(opened),timeZone:ZONE,state:'upcoming'});
  await decide(db,1,cycle,2); // Bob already chose
  await db.execute(`INSERT INTO user_notification_prefs (user_id,email_enabled) VALUES (4,0)`); // Carol opted out
  const result=await enqueueDueReminders(db,{now:at(opened)});
  assert.equal(result.availability_cutoff,1);
  const rows=await queued(db);
  const key=availabilityCycleKey({kind:'circle',circleId:1},cycle);
  assert.deepEqual(rows.map(row=>row.key),[`reminder-email/v1/availability-cutoff/1/${key}/1`]);
  assert.deepEqual(rows[0].payload,{kind:'availability_cutoff',circle_id:1,cycle_key:key,recipient_user_id:1,
    template_version:1});
  assert.doesNotMatch(JSON.stringify(rows[0].payload),/@|Alice|2098/);
  // The per-kind bound is clamped; an invalid bound falls back to the default.
  await db.execute(`DELETE FROM pairing_cycle_availability WHERE user_id=2`);
  await db.execute(`DELETE FROM user_notification_prefs WHERE user_id=4`);
  assert.equal((await enqueueDueReminders(db,{now:at(opened),limit:1})).availability_cutoff,1,
    'already-queued members do not consume the bound');
  assert.equal((await enqueueDueReminders(db,{now:at(opened),limit:'all'})).availability_cutoff,1);
  await db.execute(`DELETE FROM outbox_events WHERE json_extract(payload_json,'$.recipient_user_id')<>1`);
  await decide(db,1,cycle,2);
  await db.execute(`INSERT INTO user_notification_prefs (user_id,email_enabled) VALUES (4,0)`);
  // Re-running within the window (every five minutes) never duplicates.
  assert.equal((await enqueueDueReminders(db,{now:at(plus(CUTOFF,-1))})).availability_cutoff,0);
  assert.equal((await queued(db)).length,1);
});

test('the cutoff window follows the local boundary across the October DST change',async()=>{
  const db=await fixture();
  // Sunday 2098-10-26 is both the BST->GMT change and a cutoff (08:00 GMT).
  assert.equal((await enqueueDueReminders(db,{now:at('2098-10-25T07:59:59.999Z')})).availability_cutoff,0);
  assert.equal((await enqueueDueReminders(db,{now:at('2098-10-25T08:00:00.000Z')})).availability_cutoff,3);
  const cycle=resolvePairingCycle({now:new Date('2098-10-25T08:00:00.000Z'),timeZone:ZONE,state:'upcoming'});
  assert.equal(cycle.cutoffAt,'2098-10-26T08:00:00.000Z');
});

test('cutoff reminders are suppressed at send when a decision exists, the cutoff passed, or the member left',async()=>{
  const db=await fixture();
  const opened=plus(CUTOFF,-AVAILABILITY_CUTOFF_LEAD_MS);
  await enqueueDueReminders(db,{now:at(opened)});
  const rows=await queued(db);
  assert.equal(rows.length,3);
  const byUser=Object.fromEntries(rows.map(row=>[row.payload.recipient_user_id,row]));
  const {sent,send}=capture();
  const handler=handlerAt(db,plus(opened,60_000),send);
  const delivered=await handler(eventFrom(byUser[1]),{});
  assert.equal(delivered.status,'delivered');
  assert.equal(sent[0].to,'alice@example.test');
  assert.equal(sent[0].idempotencyKey,byUser[1].key);
  assert.equal(sent[0].subject,'Are you in for the next Randori cycle?');
  assert.match(sent[0].html,/Sunday 21 September 2098, 08:00 \(Europe\/London\)/);
  assert.deepEqual([...sent[0].html.matchAll(/href="([^"]+)"/gu)].map(match=>match[1]),[`${ORIGIN}/?view=pair`]);
  // Bob sees his own timezone; Carol's invalid zone falls back to UTC.
  await handler(eventFrom(byUser[2]),{});
  assert.match(sent[1].html,/Sunday 21 September 2098, 03:00 \(America\/New_York\)/);
  await handler(eventFrom(byUser[4]),{});
  assert.match(sent[2].html,/Sunday 21 September 2098, 07:00 \(UTC\)/);

  const cycle=resolvePairingCycle({now:new Date(opened),timeZone:ZONE,state:'upcoming'});
  await decide(db,1,cycle,1);
  assert.deepEqual(await handler(eventFrom(byUser[1]),{}),{status:'suppressed',reasonCode:'DECISION_MADE'});
  assert.deepEqual(await handlerAt(db,CUTOFF,send)(eventFrom(byUser[2]),{}),
    {status:'suppressed',reasonCode:'CUTOFF_PASSED'});
  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=1 AND user_id=2`);
  assert.deepEqual(await handler(eventFrom(byUser[2]),{}),{status:'suppressed',reasonCode:'MEMBER_REMOVED'});
  await db.execute(`INSERT INTO user_notification_prefs (user_id,email_enabled) VALUES (4,0)`);
  assert.deepEqual(await handler(eventFrom(byUser[4]),{}),{status:'suppressed',reasonCode:'EMAIL_DISABLED'});
  await db.execute(`UPDATE auth_accounts SET email='not-an-email' WHERE id=4`);
  await db.execute(`UPDATE user_notification_prefs SET email_enabled=1 WHERE user_id=4`);
  assert.deepEqual(await handler(eventFrom(byUser[4]),{}),{status:'suppressed',reasonCode:'RECIPIENT_INVALID'});
  await db.execute(`UPDATE auth_accounts SET is_demo=1 WHERE id=4`);
  assert.deepEqual(await handler(eventFrom(byUser[4]),{}),{status:'suppressed',reasonCode:'MEMBER_REMOVED'});
  delete process.env.REMINDERS_ENABLED;
  assert.deepEqual(await handler(eventFrom(byUser[4]),{}),{status:'suppressed',reasonCode:'REMINDERS_DISABLED'});
  assert.equal(sent.length,3);
});

test('the agree-a-time nudge is due 72 hours after pairing and only while no time is agreed',async()=>{
  const db=await fixture();
  const {weekId,groups:[groupId]}=await seedPrimaryWeek(db);
  const due=plus(W38_START,AGREE_TIME_NUDGE_DELAY_MS);
  assert.equal((await enqueueDueReminders(db,{now:at(plus(due,-1))})).agree_time,0);
  assert.equal((await enqueueDueReminders(db,{now:at(due)})).agree_time,2);
  assert.equal((await enqueueDueReminders(db,{now:at(plus(due,5*60_000))})).agree_time,0,'idempotent');
  const rows=await queued(db);
  assert.deepEqual(rows.map(row=>row.key),[
    `reminder-email/v1/agree-time/primary/${weekId}/${groupId}/1`,
    `reminder-email/v1/agree-time/primary/${weekId}/${groupId}/2`,
  ]);
  const {sent,send}=capture();
  const handler=handlerAt(db,due,send);
  assert.equal((await handler(eventFrom(rows[0]),{})).status,'delivered');
  assert.equal(sent[0].subject,'Agree a time with your Randori pair');
  assert.deepEqual([...sent[0].html.matchAll(/href="([^"]+)"/gu)].map(match=>match[1]),
    [`${ORIGIN}/join/week_${weekId}_pair_${groupId}`]);
  // A time agreed after the event was queued suppresses the queued nudge.
  await agree(db,weekId,groupId,'2098-09-19T18:00:00.000Z');
  assert.deepEqual(await handler(eventFrom(rows[1]),{}),{status:'suppressed',reasonCode:'TIME_AGREED'});
  // A cleared agreement before cycle end lets the nudge deliver again; a new cycle ends it.
  await agree(db,weekId,groupId,null);
  assert.equal((await handler(eventFrom(rows[1]),{})).status,'delivered');
  assert.deepEqual(await handlerAt(db,'2098-09-21T07:00:00.000Z',send)(eventFrom(rows[1]),{}),
    {status:'suppressed',reasonCode:'CYCLE_ENDED'});
  await db.execute(`INSERT INTO user_notification_prefs (user_id,email_enabled) VALUES (2,0)`);
  assert.deepEqual(await handler(eventFrom(rows[1]),{}),{status:'suppressed',reasonCode:'EMAIL_DISABLED'});
  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=1 AND user_id=2`);
  assert.deepEqual(await handler(eventFrom(rows[1]),{}),{status:'suppressed',reasonCode:'MEMBER_REMOVED'});
});

test('nudges skip agreed, AI, solo, demo, opted-out and previous-cycle pairs',async()=>{
  const db=await fixture();
  await seedPrimaryWeek(db,{weekId:9,cycleId:'2098-W37',startsAt:'2098-09-07T07:00:00.000Z',
    pairedAt:'2098-09-07 07:00:00'});
  const {weekId,groups}=await seedPrimaryWeek(db,{pairs:[[1,2],[3,4],[4]]});
  await agree(db,weekId,groups[0],'2098-09-19T18:00:00.000Z');
  const due=plus(W38_START,AGREE_TIME_NUDGE_DELAY_MS);
  assert.equal((await enqueueDueReminders(db,{now:at(due)})).agree_time,0);
  await agree(db,weekId,groups[0],'');
  await db.execute(`INSERT INTO user_notification_prefs (user_id,email_enabled) VALUES (2,0)`);
  assert.equal((await enqueueDueReminders(db,{now:at(due)})).agree_time,1);
  assert.equal((await queued(db))[0].payload.recipient_user_id,1);
  const ai=await fixture();
  const {weekId:aiWeek,groups:[aiGroup]}=await seedPrimaryWeek(ai,{ai:true});
  assert.equal((await enqueueDueReminders(ai,{now:at(due)})).agree_time,0);
  const event=eventFrom({key:`reminder-email/v1/agree-time/primary/${aiWeek}/${aiGroup}/1`,payload:{
    kind:'agree_time',scope:'primary',week_id:aiWeek,pair_group_id:aiGroup,recipient_user_id:1,template_version:1}});
  assert.deepEqual(await handlerAt(ai,due,capture().send)(event,{}),{status:'suppressed',reasonCode:'PAIR_INVALID'});
});

test('the one-hour reminder is opt-in, scheduled one hour ahead, and follows the agreed time',async()=>{
  const db=await fixture();
  const {weekId,groups:[groupId]}=await seedPrimaryWeek(db);
  const session='2098-09-18T13:00:00.000Z';
  await agree(db,weekId,groupId,session);
  const early='2098-09-18T11:54:59.999Z';
  const queuedAt='2098-09-18T11:55:00.000Z';
  assert.equal((await enqueueDueReminders(db,{now:at(queuedAt)})).session_soon,0,'off unless enabled');
  process.env.REMINDERS_SESSION_SOON_ENABLED='true';
  assert.equal((await enqueueDueReminders(db,{now:at(early)})).session_soon,0);
  assert.equal((await enqueueDueReminders(db,{now:at(queuedAt)})).session_soon,2);
  assert.equal((await enqueueDueReminders(db,{now:at(queuedAt)})).session_soon,0,'idempotent');
  // Already-queued reminders do not use up the per-run bound for a later
  // session, here from the previous week's pair (schedules outlive the cycle).
  const later=await seedPrimaryWeek(db,{weekId:9,cycleId:'2098-W37',startsAt:'2098-09-07T07:00:00.000Z',
    pairedAt:'2098-09-07 07:00:00',pairs:[[4,2]]});
  await agree(db,later.weekId,later.groups[0],'2098-09-18T12:30:00.000Z');
  assert.equal((await enqueueDueReminders(db,{now:at(queuedAt),limit:2})).session_soon,2);
  const rows=(await queued(db)).filter(row=>row.payload.kind==='session_soon');
  const fingerprint=reminderInstantFingerprint(session);
  assert.equal(rows[0].key,`reminder-email/v1/session-soon/primary/${weekId}/${groupId}/${fingerprint}/1`);
  assert.equal(rows[0].notBefore,new Date(Date.parse(session)-SESSION_SOON_LEAD_MS).toISOString());
  assert.doesNotMatch(JSON.stringify(rows[0].payload),/2098-09-18/);
  const {sent,send}=capture();
  const sendAt='2098-09-18T12:00:00.000Z';
  assert.equal((await handlerAt(db,sendAt,send)(eventFrom(rows[1]),{})).status,'delivered');
  assert.equal(sent[0].subject,'Your Randori session starts soon');
  assert.match(sent[0].html,/Thursday 18 September 2098, 09:00 \(America\/New_York\)/);
  assert.deepEqual(await handlerAt(db,session,send)(eventFrom(rows[0]),{}),
    {status:'suppressed',reasonCode:'SESSION_ELAPSED'});
  await agree(db,weekId,groupId,'2098-09-18T15:00:00.000Z');
  assert.deepEqual(await handlerAt(db,sendAt,send)(eventFrom(rows[0]),{}),
    {status:'suppressed',reasonCode:'SESSION_CHANGED'});
  await agree(db,weekId,groupId,null);
  assert.deepEqual(await handlerAt(db,sendAt,send)(eventFrom(rows[0]),{}),
    {status:'suppressed',reasonCode:'SESSION_CLEARED'});
  delete process.env.REMINDERS_SESSION_SOON_ENABLED;
  assert.deepEqual(await handlerAt(db,sendAt,send)(eventFrom(rows[0]),{}),
    {status:'suppressed',reasonCode:'REMINDERS_DISABLED'});
  assert.equal(sent.length,1);
});

test('secondary circles get circle-named, dashboard-only reminders for all three kinds',async()=>{
  enableSecondary();
  process.env.REMINDERS_SESSION_SOON_ENABLED='true';
  const db=await fixture();
  const opened=plus(CUTOFF,-AVAILABILITY_CUTOFF_LEAD_MS);
  assert.equal((await enqueueDueReminders(db,{now:at(opened)})).availability_cutoff,5,'3 primary + 2 secondary');
  const secondaryCutoff=(await queued(db)).filter(row=>row.payload.circle_id===20);
  assert.equal(secondaryCutoff.length,2);
  const {sent,send}=capture();
  await handlerAt(db,opened,send)(eventFrom(secondaryCutoff[0]),{});
  assert.equal(sent[0].subject,'Night <Owls> — Are you in for the next Randori cycle?');
  assert.match(sent[0].html,/for Night &lt;Owls&gt;/);

  const db2=await fixture();
  const {publicationId,groupId}=await seedSecondary(db2,{agreedTime:null});
  const due=plus(W38_START,AGREE_TIME_NUDGE_DELAY_MS);
  assert.equal((await enqueueDueReminders(db2,{now:at(due)})).agree_time,2);
  const nudges=await queued(db2);
  assert.equal(nudges[0].key,`reminder-email/v1/agree-time/secondary/${publicationId}/${groupId}/1`);
  const handler=handlerAt(db2,due,send);
  assert.equal((await handler(eventFrom(nudges[0]),{})).status,'delivered');
  assert.equal(sent[1].subject,'Night <Owls> — Agree a time with your Randori pair');
  assert.deepEqual([...sent[1].html.matchAll(/href="([^"]+)"/gu)].map(match=>match[1]),[`${ORIGIN}/?view=dashboard`]);
  await db2.execute({sql:`UPDATE circle_pair_schedules SET agreed_time=? WHERE group_id=?`,
    args:['2098-09-18T13:00:00.000Z',groupId]});
  assert.deepEqual(await handler(eventFrom(nudges[1]),{}),{status:'suppressed',reasonCode:'TIME_AGREED'});
  assert.equal((await enqueueDueReminders(db2,{now:at('2098-09-18T11:55:00.000Z')})).session_soon,2);
  const soon=(await queued(db2)).filter(row=>row.payload.kind==='session_soon');
  assert.equal(soon[0].payload.scope,'secondary');
  assert.equal((await handlerAt(db2,'2098-09-18T12:00:00.000Z',send)(eventFrom(soon[0]),{})).status,'delivered');
  assert.equal(sent[2].subject,'Night <Owls> — Your Randori session starts soon');
  const sendAt=handlerAt(db2,'2098-09-18T12:00:00.000Z',send);
  await db2.execute(`UPDATE circles SET name='   ' WHERE id=20`);
  assert.equal((await sendAt(eventFrom(soon[1]),{})).status,'delivered');
  assert.equal(sent[3].subject,'Your circle — Your Randori session starts soon');
  await db2.execute(`INSERT INTO user_notification_prefs (user_id,email_enabled) VALUES (1,0)`);
  assert.deepEqual(await sendAt(eventFrom(soon[0]),{}),{status:'suppressed',reasonCode:'EMAIL_DISABLED'});
  await db2.execute(`DELETE FROM user_notification_prefs`);
  await db2.execute(`UPDATE auth_accounts SET is_demo=1 WHERE id=2`);
  assert.deepEqual(await sendAt(eventFrom(soon[0]),{}),{status:'suppressed',reasonCode:'PARTNER_REVOKED'});
  await db2.execute(`UPDATE auth_accounts SET is_demo=0 WHERE id=2`);
  await db2.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=20 AND user_id=2`);
  assert.deepEqual(await sendAt(eventFrom(soon[0]),{}),{status:'suppressed',reasonCode:'PARTNER_REVOKED'},
    'the partner left');
  assert.deepEqual(await sendAt(eventFrom(soon[1]),{}),{status:'suppressed',reasonCode:'MEMBER_REMOVED'},
    'the recipient left');
  delete process.env.SECONDARY_CIRCLE_SCHEDULING_ENABLED;
  assert.deepEqual(await handlerAt(db2,'2098-09-18T12:00:00.000Z',send)(eventFrom(soon[0]),{}),
    {status:'suppressed',reasonCode:'SECONDARY_SCHEDULING_DISABLED'});
  // Without multi-circle availability, secondary cutoff reminders are neither queued nor sent.
  delete process.env.MULTI_CIRCLE_AVAILABILITY_ENABLED;
  assert.deepEqual(await handlerAt(db,opened,send)(eventFrom(secondaryCutoff[1]),{}),
    {status:'suppressed',reasonCode:'SECONDARY_AVAILABILITY_DISABLED'});
  const db3=await fixture();
  assert.equal((await enqueueDueReminders(db3,{now:at(opened)})).availability_cutoff,3);
});

test('secondary nudges wait 72 hours after publication and skip removed partners',async()=>{
  enableSecondary();
  const db=await fixture();
  await seedSecondary(db,{createdAt:'2098-09-15T10:00:00.000Z',agreedTime:undefined});
  assert.equal((await enqueueDueReminders(db,{now:at('2098-09-18T09:59:59.999Z')})).agree_time,0);
  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=20 AND user_id=2`);
  assert.equal((await enqueueDueReminders(db,{now:at('2098-09-18T10:00:00.000Z')})).agree_time,0);
  await db.execute(`UPDATE circle_memberships SET status='active' WHERE circle_id=20 AND user_id=2`);
  assert.equal((await enqueueDueReminders(db,{now:at('2098-09-18T10:00:00.000Z')})).agree_time,2);
});

test('retries and dead-letter replays reuse one provider idempotency key and never re-enqueue',async()=>{
  const db=await fixture();
  // Real SQLite time is long before 2098, so the queued event is immediately due.
  await enqueueDueReminders(db,{now:at(plus(CUTOFF,-AVAILABILITY_CUTOFF_LEAD_MS))});
  await db.execute(`DELETE FROM outbox_events WHERE json_extract(payload_json,'$.recipient_user_id')<>1`);
  const keys=[];
  let failures=1;
  const send=async message=>{
    keys.push(message.idempotencyKey);
    if(failures-->0) throw Object.assign(new Error('upstream'),{statusCode:503});
    return {providerName:'capture',providerMessageId:'m-1'};
  };
  const handler=createReminderEmailHandler({db,baseUrl:ORIGIN,send,now:at(plus(CUTOFF,-60_000))});
  const options={db,eventType:REMINDER_EMAIL_EVENT_TYPE,handlers:{[REMINDER_EMAIL_EVENT_TYPE]:handler},
    heartbeatIntervalMs:0,leaseDurationMs:1000,baseBackoffMs:1,maxBackoffMs:1};
  // The 1 ms backoff elapses inside the same bounded drain: one retry, then delivery.
  const firstRun=await runOutboxWorker(options);
  assert.equal(firstRun.retried,1);
  assert.equal(firstRun.delivered,1);
  assert.equal(new Set(keys).size,1);
  const audit=await db.execute(`SELECT reason_code FROM outbox_audit_events WHERE action='retry_scheduled'`);
  assert.equal(String(audit.rows[0].reason_code),'503:other:other');
  // A forced dead letter replayed by an operator reaches the provider with the same key.
  await db.execute(`UPDATE outbox_events SET status='dead_letter',dead_lettered_at=updated_at`);
  const [{id}]=(await db.execute(`SELECT id FROM outbox_events`)).rows;
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin)
    VALUES (9,'ops@example.test','hash','Ops','#999',1)`);
  assert.equal(await replayDeadLetter(db,{eventId:Number(id),operatorUserId:9,reasonCode:'OPERATOR_RETRY'}),true);
  assert.equal((await runOutboxWorker(options)).delivered,1);
  assert.equal(new Set(keys).size,1);
  assert.equal(keys.length,3);
  assert.equal((await enqueueDueReminders(db,{now:at(plus(CUTOFF,-30_000))})).availability_cutoff,2,
    'only the members whose rows were removed are queued again');
});

test('payloads, versions, and factory inputs are validated strictly',async()=>{
  assert.throws(()=>createReminderEmailHandler({send(){},baseUrl:ORIGIN}),/database and provider/);
  assert.throws(()=>createReminderEmailHandler({db:{execute(){}},baseUrl:ORIGIN}),/database and provider/);
  assert.throws(()=>createReminderEmailHandler({db:{execute(){}},send(){},baseUrl:'nope'}),/base URL/);
  const handler=createReminderEmailHandler({db:{execute(){ throw new Error('unreachable'); }},send(){},baseUrl:ORIGIN});
  const base={kind:'agree_time',scope:'primary',week_id:1,pair_group_id:2,recipient_user_id:3,template_version:1};
  await assert.rejects(()=>handler({eventVersion:2,payload:base}),error=>error.code==='EVENT_VERSION_UNSUPPORTED');
  for(const payload of [null,[],{...base,extra:1},{...base,scope:'other'},{...base,kind:'unknown'},
    {...base,template_version:2},{...base,recipient_user_id:0},{...base,week_id:'1'},
    {kind:'availability_cutoff',circle_id:1,cycle_key:'short',recipient_user_id:1,template_version:1},
    {kind:'session_soon',scope:'secondary',publication_id:1,group_id:2,instant_fingerprint:'x',recipient_user_id:1,
      template_version:1}]){
    await assert.rejects(()=>handler({eventVersion:1,payload}),error=>error instanceof OutboxDeliveryError
      &&error.code==='PAYLOAD_INVALID'&&error.retryable===false,JSON.stringify(payload));
  }
  assert.throws(()=>reminderEventStatement({...base,week_id:-1}),/Outbox delivery failed/);
  assert.throws(()=>reminderInstantFingerprint('2098-09-18T13:00:00Z'),/normalized/);
  const statement=reminderEventStatement({kind:'session_soon',scope:'secondary',publication_id:4,group_id:5,
    instant_fingerprint:'a'.repeat(64),recipient_user_id:6},{notBefore:'2098-01-01T00:00:00.000Z'});
  assert.equal(statement.args[2],`reminder-email/v1/session-soon/secondary/4/5/${'a'.repeat(64)}/6`);
});

test('provider failures are classified with bounded, PII-free reasons',async()=>{
  const db=await fixture();
  const {weekId,groups:[groupId]}=await seedPrimaryWeek(db);
  const due=plus(W38_START,AGREE_TIME_NUDGE_DELAY_MS);
  await enqueueDueReminders(db,{now:at(due)});
  const [row]=await queued(db);
  const attempt=async failure=>{
    const handler=handlerAt(db,due,async()=>{ if(failure.result) return failure.result; throw failure.error; });
    try{ await handler(eventFrom(row),{}); return null; }
    catch(error){ return error; }
  };
  const limited=await attempt({error:Object.assign(new Error('Too many requests for alice@example.test'),
    {statusCode:429,name:'rate_limit_exceeded',retryAfterMs:2000})});
  assert.equal(limited.code,'PROVIDER_RATE_LIMITED');
  assert.equal(limited.retryAfterMs,2000);
  assert.equal(limited.providerReason,'429:rate_limit_exceeded:rate_limited');
  const rejected=await attempt({result:{error:Object.assign(
    new Error('You can only send testing emails to your own email address (owner@example.test).'),
    {statusCode:403,name:'validation_error'})}});
  assert.equal(rejected.code,'PROVIDER_REJECTED');
  assert.equal(rejected.retryable,false);
  assert.equal(rejected.providerReason,'403:validation_error:testing_recipient_restricted');
  assert.doesNotMatch(JSON.stringify(rejected.providerReason),/@/);
  const unavailable=await attempt({error:{status:502}});
  assert.equal(unavailable.code,'PROVIDER_UNAVAILABLE');
  const network=await attempt({error:new Error('socket hang up')});
  assert.equal(network.code,'PROVIDER_FAILED');
  assert.equal(network.providerReason,null);
  const nested=await attempt({error:{response:{status:503}}});
  assert.equal(nested.code,'PROVIDER_UNAVAILABLE');
  const wrapped=await attempt({error:{error:{statusCode:422,name:'validation_error',message:'Invalid `to` field'}}});
  assert.equal(wrapped.code,'PROVIDER_REJECTED');
  const bareLimit=await attempt({error:{statusCode:429}});
  assert.equal(bareLimit.code,'PROVIDER_RATE_LIMITED');
  assert.equal(bareLimit.retryAfterMs,0,'no provider hint: the normal backoff applies');
  const snakeLimit=await attempt({error:{statusCode:429,retry_after_ms:500}});
  assert.equal(snakeLimit.retryAfterMs,500);
  const passthrough=new OutboxDeliveryError('DELIVERY_TIMEOUT');
  assert.equal(await attempt({error:passthrough}),passthrough);
  const delivered=await handlerAt(db,due,async()=>({data:{id:'re_123'}}))(eventFrom(row),{});
  assert.deepEqual(delivered,{status:'delivered',providerName:'email',providerMessageId:'re_123'});
  assert.deepEqual(await handlerAt(db,due,async()=>({}))(eventFrom(row),{}),
    {status:'delivered',providerName:'email',providerMessageId:null});
  assert.ok(weekId&&groupId);
});

test('rendering escapes content, links only to the dashboard or room, and shows the recipient timezone',()=>{
  assert.equal(formatReminderInstant(CUTOFF,'Asia/Tokyo'),'Sunday 21 September 2098, 16:00 (Asia/Tokyo)');
  assert.equal(formatReminderInstant(CUTOFF,null),'Sunday 21 September 2098, 07:00 (UTC)');
  assert.equal(formatReminderInstant(CUTOFF,'x'.repeat(101)),'Sunday 21 September 2098, 07:00 (UTC)');
  const email=renderReminderEmail({kind:'agree_time',origin:ORIGIN,link:'/join/week_1_pair_2',circleName:null});
  assert.match(email.html,/Open your private pairing room/);
  const named=renderReminderEmail({kind:'session_soon',origin:ORIGIN,link:'/?view=dashboard',
    circleName:'<script>',instant:CUTOFF,timeZone:'UTC'});
  assert.doesNotMatch(named.html,/<script>/);
  assert.match(named.html,/Open the Randori dashboard/);
  for(const html of [email.html,named.html]){
    const links=[...html.matchAll(/href="([^"]+)"/gu)].map(match=>match[1]);
    assert.equal(links.length,1);
    assert.match(links[0],/^https:\/\/randori\.example\.test\/(?:join\/week_\d+_pair_\d+|\?view=dashboard)$/u);
    assert.doesNotMatch(html,/token|invite=|reset/i);
    assert.match(html,/Reminders can arrive a few minutes late/);
  }
});

test('the due-check and handler default to the wall clock',async()=>{
  const {directory,url}=await createMigratedDatabase({prefix:'randori-reminders-clock-',filename:'clock.sqlite'});
  const db=createClient({url});
  cleanup.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  process.env.REMINDERS_SESSION_SOON_ENABLED='true';
  // No circles or pairs exist, so the result is deterministic at any real time.
  assert.deepEqual(await enqueueDueReminders(db),
    {enabled:true,availability_cutoff:0,agree_time:0,session_soon:0,errors:{}});
  const handler=createReminderEmailHandler({db,baseUrl:ORIGIN,send:async()=>{ throw new Error('not sent'); }});
  assert.deepEqual(await handler({eventVersion:1,idempotencyKey:'reminder-email/v1/x',payload:{kind:'agree_time',
    scope:'primary',week_id:1,pair_group_id:1,recipient_user_id:1,template_version:1}},{}),
  {status:'suppressed',reasonCode:'MEMBER_REMOVED'});
});

test('the cutoff window also follows the March DST change (a 23-hour local window)',async()=>{
  const db=await fixture();
  // Sunday 2098-03-30 is the GMT->BST change; its cutoff is 08:00 BST (07:00Z).
  assert.equal((await enqueueDueReminders(db,{now:at('2098-03-29T06:59:59.999Z')})).availability_cutoff,0);
  assert.equal((await enqueueDueReminders(db,{now:at('2098-03-29T07:00:00.000Z')})).availability_cutoff,3);
  assert.equal(resolvePairingCycle({now:new Date('2098-03-29T07:00:00.000Z'),timeZone:ZONE,state:'upcoming'}).cutoffAt,
    '2098-03-30T07:00:00.000Z');
});

test('a partner who left the primary circle suppresses the nudge and the one-hour reminder for both',async()=>{
  process.env.REMINDERS_SESSION_SOON_ENABLED='true';
  const db=await fixture();
  const {weekId,groups:[groupId]}=await seedPrimaryWeek(db);
  const due=plus(W38_START,AGREE_TIME_NUDGE_DELAY_MS);
  // Queued on Tuesday while both are members...
  assert.equal((await enqueueDueReminders(db,{now:at(due)})).agree_time,2);
  const nudges=await queued(db);
  // ...Bob leaves; Alice's queued nudge is suppressed and nothing new is queued.
  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=1 AND user_id=2`);
  const {sent,send}=capture();
  assert.deepEqual(await handlerAt(db,plus(due,24*3600_000),send)(eventFrom(nudges[0]),{}),
    {status:'suppressed',reasonCode:'PARTNER_REVOKED'});
  await agree(db,weekId,groupId,'2098-09-18T13:00:00.000Z');
  assert.equal((await enqueueDueReminders(db,{now:at('2098-09-18T11:55:00.000Z')})).session_soon,0);
  await db.execute(`UPDATE circle_memberships SET status='active' WHERE circle_id=1 AND user_id=2`);
  assert.equal((await enqueueDueReminders(db,{now:at('2098-09-18T11:55:00.000Z')})).session_soon,2);
  const soon=(await queued(db)).filter(row=>row.payload.kind==='session_soon');
  await db.execute(`UPDATE auth_accounts SET is_demo=1 WHERE id=2`);
  assert.deepEqual(await handlerAt(db,'2098-09-18T12:00:00.000Z',send)(eventFrom(soon[0]),{}),
    {status:'suppressed',reasonCode:'PARTNER_REVOKED'});
  await db.execute(`UPDATE auth_accounts SET is_demo=0 WHERE id=2`);
  assert.equal((await handlerAt(db,'2098-09-18T12:00:00.000Z',send)(eventFrom(soon[0]),{})).status,'delivered');
  assert.equal(sent.length,1);
});

test('a session agreed after the Sunday boundary still gets its one-hour reminder; the nudge does not',async()=>{
  process.env.REMINDERS_SESSION_SOON_ENABLED='true';
  const db=await fixture();
  const {weekId,groups:[groupId]}=await seedPrimaryWeek(db);
  const older=await seedPrimaryWeek(db,{weekId:8,cycleId:'2098-W37',startsAt:'2098-09-07T07:00:00.000Z',
    pairedAt:'2098-09-07 07:00:00',pairs:[[4,2]]});
  // Week-38 pair agrees Sunday 10:00 BST, after the 08:00 boundary into week 39.
  const session='2098-09-21T09:00:00.000Z';
  await agree(db,weekId,groupId,session);
  await agree(db,8,older.groups[0],session); // two cycles back: out of scope
  const queuedAt='2098-09-21T08:00:00.000Z';
  assert.equal(resolvePairingCycle({now:new Date(queuedAt),timeZone:ZONE}).cycleId,'2098-W39');
  assert.equal((await enqueueDueReminders(db,{now:at(queuedAt)})).session_soon,2);
  const soon=(await queued(db)).filter(row=>row.payload.kind==='session_soon');
  assert.deepEqual(soon.map(row=>row.payload.week_id),[weekId,weekId]);
  const {sent,send}=capture();
  assert.equal((await handlerAt(db,queuedAt,send)(eventFrom(soon[0]),{})).status,'delivered');
  const nudge=eventFrom({key:`reminder-email/v1/agree-time/primary/${weekId}/${groupId}/1`,payload:{
    kind:'agree_time',scope:'primary',week_id:weekId,pair_group_id:groupId,recipient_user_id:1,template_version:1}});
  await agree(db,weekId,groupId,null);
  assert.deepEqual(await handlerAt(db,queuedAt,send)(nudge,{}),{status:'suppressed',reasonCode:'CYCLE_ENDED'});
});

test('a session less than 15 minutes away gets no short-notice reminder',async()=>{
  process.env.REMINDERS_SESSION_SOON_ENABLED='true';
  const db=await fixture();
  const {weekId,groups:[groupId]}=await seedPrimaryWeek(db);
  const session='2098-09-18T13:00:00.000Z';
  await agree(db,weekId,groupId,session);
  // Agreed with 14 minutes to go: never queued.
  assert.equal((await enqueueDueReminders(db,{now:at(plus(session,-SESSION_SOON_MIN_LEAD_MS+60_000))})).session_soon,0);
  // Queued in time, but delivery ran late: suppressed rather than sent.
  assert.equal((await enqueueDueReminders(db,{now:at(plus(session,-SESSION_SOON_MIN_LEAD_MS))})).session_soon,0,
    'the boundary itself is excluded');
  assert.equal((await enqueueDueReminders(db,{now:at(plus(session,-SESSION_SOON_MIN_LEAD_MS-1))})).session_soon,2);
  const [row]=(await queued(db)).filter(item=>item.payload.kind==='session_soon');
  const {sent,send}=capture();
  assert.deepEqual(await handlerAt(db,plus(session,-SESSION_SOON_MIN_LEAD_MS+1),send)(eventFrom(row),{}),
    {status:'suppressed',reasonCode:'SESSION_IMMINENT'});
  assert.equal((await handlerAt(db,plus(session,-SESSION_SOON_MIN_LEAD_MS),send)(eventFrom(row),{})).status,'delivered');
  assert.equal(sent.length,1);
});

test('the nudge reads the current week first and skips pair queries until its pairing is 72 hours old',async()=>{
  const db=await fixture();
  await seedPrimaryWeek(db,{pairedAt:'2098-09-15T07:00:00.000Z'});
  const statements=[];
  const spy={execute(statement){ statements.push(typeof statement==='string'?statement:statement.sql);
    return db.execute(statement); },batch:(...args)=>db.batch(...args)};
  assert.equal((await enqueueDueReminders(spy,{now:at('2098-09-18T06:59:59.999Z')})).agree_time,0);
  assert.equal(statements.some(sql=>/WITH pairs AS MATERIALIZED/.test(sql)),false,'no pair scan before 72 hours');
  assert.equal((await enqueueDueReminders(spy,{now:at('2098-09-18T07:00:00.000Z')})).agree_time,2,
    'ISO-formatted run times are read too');
  const unknown=await fixture();
  await seedPrimaryWeek(unknown,{pairedAt:'not a time'});
  assert.equal((await enqueueDueReminders(unknown,{now:at(THURSDAY)})).agree_time,0);
  assert.equal((await enqueueDueReminders(await fixture(),{now:at(THURSDAY)})).agree_time,0,'no week published');
});

test('one failing kind reports a bounded code without stopping the others, and session_soon runs first',async()=>{
  process.env.REMINDERS_SESSION_SOON_ENABLED='true';
  const db=await fixture();
  await seedPrimaryWeek(db);
  const order=[];
  const failing=(code)=>({
    execute(statement){
      const sql=typeof statement==='string'?statement:statement.sql;
      if(/FROM pair_schedules schedule/.test(sql)) order.push('session_soon');
      if(/LEFT JOIN pair_schedules schedule/.test(sql)){
        order.push('agree_time');
        return Promise.reject(Object.assign(new Error('locked'),code?{code}:{}));
      }
      if(/FROM circles WHERE archived_at IS NULL/.test(sql)) order.push('availability_cutoff');
      return db.execute(statement);
    },
    batch:(...args)=>db.batch(...args),
  });
  // Saturday inside the cutoff window, 72+ hours after pairing.
  const saturday=plus(CUTOFF,-3600_000);
  const busy=await enqueueDueReminders(failing('SQLITE_BUSY'),{now:at(saturday)});
  assert.deepEqual(busy,{enabled:true,availability_cutoff:3,agree_time:null,session_soon:0,
    errors:{agree_time:'SQLITE_BUSY'}});
  assert.deepEqual(order,['session_soon','agree_time','availability_cutoff']);
  const opaque=await enqueueDueReminders(failing(null),{now:at(saturday)});
  assert.deepEqual(opaque.errors,{agree_time:'QUERY_FAILED'});
  const odd=await enqueueDueReminders(failing('not a code'),{now:at(saturday)});
  assert.deepEqual(odd.errors,{agree_time:'QUERY_FAILED'});
});

test('a membership-free local runtime uses the local availability scope, as the availability endpoint does',async()=>{
  process.env.REMINDERS_SESSION_SOON_ENABLED='true';
  const db=await fixture();
  // No circle memberships in this runtime; decisions live under scope `local`.
  await db.execute(`DELETE FROM circle_memberships`);
  const opened=plus(CUTOFF,-AVAILABILITY_CUTOFF_LEAD_MS);
  assert.equal((await enqueueDueReminders(db,{now:at(opened)})).availability_cutoff,0,'circle scope finds nobody');
  const cycle=resolvePairingCycle({now:new Date(opened),timeZone:ZONE,state:'upcoming'});
  const localKey=availabilityCycleKey({kind:'local'},cycle);
  await db.execute({sql:`INSERT INTO pairing_cycles
      (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
    VALUES ('local',NULL,?,?,?,?,?,?,'cycle_default')`,
  args:[localKey,cycle.cycleId,cycle.startsAt,cycle.endsAt,cycle.cutoffAt,cycle.timeZone]});
  await db.execute({sql:`INSERT INTO pairing_cycle_availability
      (scope_key,cycle_key,user_id,is_available,version,decision_source) VALUES ('local',?,4,1,1,'user')`,
  args:[localKey]});
  assert.equal((await enqueueDueReminders(db,{now:at(opened),localScope:true})).availability_cutoff,2);
  const rows=await queued(db);
  assert.deepEqual(rows.map(row=>row.key),[1,2].map(id=>`reminder-email/v1/availability-cutoff/local/${localKey}/${id}`));
  assert.deepEqual(rows[0].payload,{kind:'availability_cutoff',scope:'local',cycle_key:localKey,recipient_user_id:1,
    template_version:1});
  const {sent,send}=capture();
  const local=createReminderEmailHandler({db,baseUrl:ORIGIN,send,now:at(opened),localScope:true});
  assert.equal((await local(eventFrom(rows[0]),{})).status,'delivered');
  assert.equal(sent[0].subject,'Are you in for the next Randori cycle?');
  await db.execute({sql:`INSERT INTO pairing_cycle_availability
      (scope_key,cycle_key,user_id,is_available,version,decision_source) VALUES ('local',?,2,0,1,'user')`,
  args:[localKey]});
  assert.deepEqual(await local(eventFrom(rows[1]),{}),{status:'suppressed',reasonCode:'DECISION_MADE'});
  assert.deepEqual(await handlerAt(db,opened,send)(eventFrom(rows[0]),{}),
    {status:'suppressed',reasonCode:'SCOPE_CHANGED'});
  assert.deepEqual(await local(eventFrom({key:'reminder-email/v1/x',payload:{kind:'availability_cutoff',scope:'local',
    cycle_key:localKey,recipient_user_id:99,template_version:1}}),{}),{status:'suppressed',reasonCode:'MEMBER_REMOVED'});
  // Pair reminders need no circle membership in this runtime either.
  const {weekId,groups:[groupId]}=await seedPrimaryWeek(db);
  await agree(db,weekId,groupId,'2098-09-18T13:00:00.000Z');
  assert.equal((await enqueueDueReminders(db,{now:at('2098-09-18T11:55:00.000Z'),localScope:true})).session_soon,2);
  const soon=(await queued(db)).find(row=>row.payload.kind==='session_soon');
  const pairHandler=createReminderEmailHandler({db,baseUrl:ORIGIN,send,now:at('2098-09-18T12:00:00.000Z'),localScope:true});
  assert.equal((await pairHandler(eventFrom(soon),{})).status,'delivered');
  assert.deepEqual(await handlerAt(db,'2098-09-18T12:00:00.000Z',send)(eventFrom(soon),{}),
    {status:'suppressed',reasonCode:'MEMBER_REMOVED'},'outside the local runtime membership is required');
  assert.throws(()=>reminderEventStatement({kind:'availability_cutoff',scope:'local',circle_id:1,cycle_key:localKey,
    recipient_user_id:1}),/Outbox delivery failed/);
  assert.throws(()=>reminderEventStatement({kind:'availability_cutoff',scope:'circle',cycle_key:localKey,
    recipient_user_id:1}),/Outbox delivery failed/);
});

test('the local availability scope applies only to a strict loopback runtime with membership disabled',async()=>{
  const {localAvailabilityScope}=await import('../../api/_local-runtime.js');
  const keys=['NODE_ENV','RANDORI_LOCAL_RUNTIME','TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','APP_URL',
    'CIRCLE_MEMBERSHIP_ENABLED','VERCEL','VERCEL_ENV','VERCEL_URL'];
  const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try{
    for(const key of keys) delete process.env[key];
    Object.assign(process.env,{NODE_ENV:'development',RANDORI_LOCAL_RUNTIME:'true',
      TURSO_DATABASE_URL:'file:///tmp/randori-local.sqlite',APP_URL:'http://127.0.0.1:3000'});
    const loopback={headers:{host:'127.0.0.1:3000'},socket:{remoteAddress:'127.0.0.1'}};
    assert.equal(localAvailabilityScope(loopback),true);
    assert.equal(localAvailabilityScope({headers:{host:'randori.example.test'},socket:{remoteAddress:'203.0.113.9'}}),
      false);
    process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
    assert.equal(localAvailabilityScope(loopback),false,'the bundled dev server uses the circle scope');
  }finally{
    for(const [key,value] of Object.entries(saved)){
      if(value===undefined) delete process.env[key]; else process.env[key]=value;
    }
  }
});
