// Issue #287 route wiring: the notification preferences response and the
// `/api/cron/outbox` due-check, against a real migrated SQLite database. Only
// api/_db.js (client and identity) and the Resend SDK (network edge) are
// replaced.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { availabilityCycleKey } from '../../api/_availability.js';
import { resolvePairingCycle } from '../../api/_pairing-cycle.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const {directory,url}=await createMigratedDatabase({prefix:'randori-reminders-ops-',filename:'ops.sqlite'});
const realDb=createClient({url});
let clientOverride=null;
const providerCalls=[];

function authFor(req){
  return req?.headers?.['x-test-auth']==='member'?{id:2,email:'bob@example.test',sessionHash:'a'.repeat(64)}:null;
}

mock.module('../../api/_db.js',{
  exports:{
    JWT_AUDIENCE:'randori-web',
    JWT_ISSUER:'randori-circle',
    getClient:()=>clientOverride||realDb,
    getJwtSecret:()=>'unit-test-secret-at-least-thirty-two-characters',
    getCronSecret:()=>process.env.CRON_SECRET,
    getAdminEmails:()=>new Set(),
    deterministicColor:()=>'#123456',
    issueSession:async()=>'session',
    issueSessionInTransaction:async()=>'session',
    revokeAccountSessions:async()=>0,
    revokeRequestSession:async()=>({authenticated:false,revoked:false,userId:null}),
    isoWeekLabel:()=>'2026-W38',
    shuffleArray:values=>[...values],
    verifyRequestAuth:authFor,
    verifySignedRequestAuth:authFor,
    verifyMutationOrigin:()=>true,
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    getSentry:()=>({Sentry:null,ready:false}),
    captureSentryMessage:()=>null,
    captureSentryException:()=>null,
  },
});
mock.module('resend',{exports:{Resend:class{
  constructor(){ this.emails={send:async(message,options)=>{
    providerCalls.push({to:message.to,subject:message.subject,html:message.html,key:options.idempotencyKey});
    return {data:{id:`re_${providerCalls.length}`}};
  }}; }
}}});

const {
  default:opsHandler,deliverPendingOutbox,OUTBOX_CRON_MAX_CLAIMS,runReminderDueCheck,
}=await import('../../api/ops.js');
const {OUTBOX_DELIVERY_TYPES}=await import('../../api/_outbox-delivery.js');
const {runOutboxInvocation}=await import('../../api/_outbox.js');
const {reminderEventStatement}=await import('../../api/_reminders.js');

function invoke({method='GET',url:path='/',query={},headers={},body}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    const response={
      status(code){ statusCode=code; return this; },
      json(payload){ resolve({status:statusCode,body:payload}); return this; },
      setHeader(){},
      end(payload){ resolve({status:statusCode,body:payload}); },
    };
    Promise.resolve(opsHandler({method,url:path,query,headers,body,socket:{remoteAddress:'203.0.113.9'}},response))
      .catch(reject);
  });
}

const ENV_KEYS=['REMINDERS_ENABLED','REMINDERS_SESSION_SOON_ENABLED','APP_URL','CRON_SECRET','RESEND_API_KEY',
  'RESEND_FROM','NODE_ENV','RANDORI_LOCAL_RUNTIME'];
const previous=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));

function sqliteDateTime(date){
  return date.toISOString().replace('T',' ').slice(0,19);
}

before(async()=>{
  await prepareMigrationConnection(realDb);
  const cycle=resolvePairingCycle({state:'current'});
  await realDb.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo,tz) VALUES
      (1,'alice@example.test','hash','Alice','#111',0,'Europe/London'),
      (2,'bob@example.test','hash','Bob','#222',0,'UTC')`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES (1,'circle_public','randori','Randori',1,1)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (1,1,'owner','active'),(1,2,'member','active')`,
    {sql:`INSERT INTO pairing_weeks (id,week_label,week_start,focus,is_demo) VALUES (10,?,?,'both',0)`,
      args:[cycle.cycleId,cycle.startsAt]},
    {sql:`INSERT INTO pairing_week_runs (week_label,week_id,generation_token,generation,algorithm_version,
        algorithm_seed,participant_count,participants_json,created_at) VALUES (?,10,'token',1,'fair-v1','seed',2,'[]',?)`,
    args:[cycle.cycleId,sqliteDateTime(new Date(Date.now()-73*60*60*1000))]},
    `INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,1,0,'auth'),(10,2,1,'auth')`,
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,is_ai_pair) VALUES (20,10,1,2,0)`,
  ],'write');
  // Both members already chose for the upcoming cycle, so a run that happens
  // to fall inside the real Saturday cutoff window queues only the nudge.
  const upcoming=resolvePairingCycle({state:'upcoming'});
  const key=availabilityCycleKey({kind:'circle',circleId:1},upcoming);
  await realDb.batch([
    {sql:`INSERT INTO pairing_cycles (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,
        default_source) VALUES ('circle:1',1,?,?,?,?,?,?,'cycle_default')`,
    args:[key,upcoming.cycleId,upcoming.startsAt,upcoming.endsAt,upcoming.cutoffAt,upcoming.timeZone]},
    {sql:`INSERT INTO pairing_cycle_availability (scope_key,cycle_key,user_id,is_available,version,decision_source)
      VALUES ('circle:1',?,1,1,1,'user'),('circle:1',?,2,1,1,'user')`,args:[key,key]},
  ],'write');
});

after(()=>{
  try{ realDb.close(); }catch{}
  rmSync(directory,{recursive:true,force:true});
  for(const [key,value] of Object.entries(previous)){
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
});

beforeEach(()=>{
  clientOverride=null;
  providerCalls.length=0;
  for(const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env,{APP_URL:'https://randori.example.test',CRON_SECRET:'reminder-cron-secret',
    RESEND_API_KEY:'re_test',RESEND_FROM:'Randori <mail@randori.example.test>'});
});

const cron={method:'POST',url:'/api/cron/outbox',query:{endpoint:'outbox'},
  headers:{'x-cron-secret':'reminder-cron-secret'}};
const prefs={url:'/api/notifications/prefs',query:{endpoint:'notifications-prefs'},headers:{'x-test-auth':'member'}};

test('the preferences response is unchanged while reminders are off and describes them when on',async()=>{
  const off=await invoke(prefs);
  assert.deepEqual(off.body,{ok:true,prefs:{user_id:2,email_enabled:1,sms_enabled:0,phone:null}});
  process.env.REMINDERS_ENABLED='true';
  const on=await invoke(prefs);
  assert.deepEqual(on.body.reminders,{availability_cutoff:true,agree_time:true,session_soon:false,
    controlled_by:'email_enabled'});
  await realDb.execute(`INSERT INTO user_notification_prefs (user_id,email_enabled) VALUES (2,0)`);
  const stored=await invoke(prefs);
  assert.equal(Number(stored.body.prefs.email_enabled),0);
  assert.equal(stored.body.reminders.agree_time,true);
  await realDb.execute(`DELETE FROM user_notification_prefs`);
});

test('with reminders off the cron neither queries nor queues reminders',async()=>{
  const seen=[];
  clientOverride={
    execute(statement){ seen.push(typeof statement==='string'?statement:statement.sql); return realDb.execute(statement); },
    batch:(...args)=>realDb.batch(...args),
    transaction:(...args)=>realDb.transaction(...args),
  };
  const response=await invoke(cron);
  assert.equal(response.status,200);
  assert.equal('reminders_enqueued' in response.body.outbox,false);
  assert.equal(seen.some(sql=>/pairing_cycle_availability|WITH pairs AS|WITH recipients|FROM circles WHERE archived_at IS NULL|week\.week_label IN/.test(sql)),false);
  assert.equal(response.body.reminder_delivery.sent,0);
  assert.equal(Number((await realDb.execute(`SELECT COUNT(*) AS count FROM outbox_events
    WHERE event_type='reminder.email.requested'`)).rows[0].count),0);
});

test('the cron due-check queues the nudge and the same invocation delivers it once per member',async()=>{
  process.env.REMINDERS_ENABLED='true';
  const first=await invoke(cron);
  assert.equal(first.status,200);
  assert.equal(first.body.outbox.reminders_enqueued.agree_time,2);
  assert.equal(first.body.outbox.types['reminder.email.requested'].delivered,2);
  assert.match(first.body.reminder_delivery.summary,/^sent 2, failed 0/);
  assert.deepEqual(providerCalls.map(call=>call.to).sort(),['alice@example.test','bob@example.test']);
  assert.ok(providerCalls.every(call=>/^reminder-email\/v1\/agree-time\/primary\/10\/20\/[12]$/.test(call.key)));
  assert.ok(providerCalls.every(call=>call.html.includes('https://randori.example.test/join/week_10_pair_20')));
  assert.equal(JSON.stringify(first.body).includes('@example.test'),false,'the cron response carries no addresses');
  const second=await invoke(cron);
  assert.equal(second.body.outbox.reminders_enqueued.agree_time,0);
  assert.equal(providerCalls.length,2,'a later run never re-sends');
});

test('a failing due-check kind is logged at warn with a bounded code while queued mail is still delivered',async()=>{
  process.env.REMINDERS_ENABLED='true';
  // Start from an empty outbox with one reminder already queued.
  await realDb.execute(`DELETE FROM outbox_audit_events`);
  await realDb.execute(`DELETE FROM outbox_events`);
  await realDb.execute(reminderEventStatement({kind:'agree_time',scope:'primary',week_id:10,pair_group_id:20,
    recipient_user_id:1}));
  let hits=0;
  clientOverride={
    execute(statement){
      const sql=typeof statement==='string'?statement:statement.sql;
      if(/WITH pairs AS MATERIALIZED/.test(sql)){ hits+=1; return Promise.reject(new Error('simulated failure')); }
      return realDb.execute(statement);
    },
    batch:(...args)=>realDb.batch(...args),
    transaction:(...args)=>realDb.transaction(...args),
  };
  const response=await invoke(cron);
  assert.equal(response.status,200);
  assert.equal(hits,1);
  assert.deepEqual(response.body.outbox.reminders_enqueued,{availability_cutoff:0,agree_time:null,session_soon:0});
  assert.deepEqual(response.body.outbox.reminder_errors,{agree_time:'QUERY_FAILED'});
  assert.equal(response.body.outbox.types['reminder.email.requested'].delivered,1);
  assert.deepEqual(providerCalls.map(call=>call.key),['reminder-email/v1/agree-time/primary/10/20/1']);
  const log=await realDb.execute(`SELECT level,meta_json FROM app_logs WHERE event='outbox_invocation'
    ORDER BY id DESC LIMIT 1`);
  assert.equal(String(log.rows[0].level),'warn');
  assert.match(String(log.rows[0].meta_json),/"reminder_errors":\{"agree_time":"QUERY_FAILED"\}/);
});

test('an unusable due-check client is reported as a failed due-check',async()=>{
  process.env.REMINDERS_ENABLED='true';
  assert.deepEqual(await runReminderDueCheck({execute(){}},{headers:{}},performance.now()+1000),
    {enqueued:null,errors:{due_check:'DUE_CHECK_FAILED'}});
});

test('the fair dispatcher still has a claim for every outbox type',async()=>{
  // runOutboxInvocation rejects a claim cap below the number of types, so a
  // ninth type would make every cron run throw until the cap is raised.
  assert.ok(OUTBOX_DELIVERY_TYPES.length<=OUTBOX_CRON_MAX_CLAIMS,
    `${OUTBOX_DELIVERY_TYPES.length} outbox types exceed OUTBOX_CRON_MAX_CLAIMS=${OUTBOX_CRON_MAX_CLAIMS}: `
    +'raise the cap (and docs/OUTBOX_INVOCATION_BUDGET.md) before adding a type');
  const handlers=Object.fromEntries(Array.from({length:OUTBOX_CRON_MAX_CLAIMS+1},(_,index)=>
    [`guard${index}.email.requested`,async()=>({})]));
  await assert.rejects(()=>runOutboxInvocation({db:realDb,handlers,eventTypes:Object.keys(handlers),
    maxClaims:OUTBOX_CRON_MAX_CLAIMS}),/invalid outbox invocation policy/);
});

test('nothing is queued when no reminder handler can deliver',async()=>{
  process.env.REMINDERS_ENABLED='true';
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  const before=Number((await realDb.execute(`SELECT COUNT(*) AS count FROM outbox_events`)).rows[0].count);
  const seen=[];
  clientOverride={
    execute(statement){ seen.push(typeof statement==='string'?statement:statement.sql); return realDb.execute(statement); },
    batch:(...args)=>realDb.batch(...args),
    transaction:(...args)=>realDb.transaction(...args),
  };
  const response=await invoke(cron);
  assert.equal(response.status,200);
  assert.equal(response.body.outbox.reminders_enqueued,null);
  assert.deepEqual(response.body.outbox.reminder_errors,{due_check:'NO_DELIVERY_HANDLER'});
  assert.equal(seen.some(sql=>/week\.week_label IN|WITH pairs AS|FROM circles WHERE archived_at IS NULL/.test(sql)),false);
  assert.equal(Number((await realDb.execute(`SELECT COUNT(*) AS count FROM outbox_events`)).rows[0].count),before);
});

test('a slow due-check is abandoned at its own budget and delivery still runs',async()=>{
  process.env.REMINDERS_ENABLED='true';
  let release;
  const stalled=new Promise(resolve=>{ release=resolve; });
  const client={
    execute(statement){
      const sql=typeof statement==='string'?statement:statement.sql;
      if(/week\.week_label IN/.test(sql)) return stalled.then(()=>realDb.execute(statement));
      return realDb.execute(statement);
    },
    batch:(...args)=>realDb.batch(...args),
    transaction:(...args)=>realDb.transaction(...args),
  };
  const result=await deliverPendingOutbox(client,'https://randori.example.test',{headers:{}},performance.now()+10_000,
    {reminderDueCheckBudgetMs:50});
  release();
  assert.equal(result.metrics.reminders_enqueued,null);
  assert.deepEqual(result.metrics.reminder_errors,{due_check:'DUE_CHECK_TIMEOUT'});
  assert.equal(result.metrics.legacy_reconciliation_complete,true);
  assert.equal(result.metrics.deadline_reached,false);
});
