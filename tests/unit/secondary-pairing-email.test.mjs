import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,test} from 'node:test';

import {createClient} from '@libsql/client';

import {
  secondaryCirclePairingEmailEnabled,
} from '../../api/_active-circle.js';
import {availabilityCycleKey} from '../../api/_availability.js';
import {publishCirclePairing} from '../../api/_circle-pairing.js';
import {
  createPairingEmailHandler,
  PAIRING_EMAIL_EVENT_TYPE,
  SECONDARY_PAIRING_EMAIL_EVENT_VERSION,
} from '../../api/_pairing-email.js';
import {runOutboxWorker} from '../../api/_outbox.js';
import {resolvePairingCycle} from '../../api/_pairing-cycle.js';
import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';

const NOW=new Date('2026-09-20T08:15:00.000Z');
const FLAGS=[
  'CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED',
  'MULTI_CIRCLE_AVAILABILITY_ENABLED','SECONDARY_CIRCLE_COORDINATION_ENABLED',
  'SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED',
];
const originalEnvironment=Object.fromEntries(FLAGS.map(key=>[key,process.env[key]]));
const resources=[];

afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
  for(const [key,value] of Object.entries(originalEnvironment)){
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
});

function enableSecondaryEmail(){
  for(const key of FLAGS) process.env[key]='true';
}

async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-secondary-email-'));
  const db=createClient({url:`file:${join(directory,'database.sqlite')}`});
  resources.push(async()=>{ await db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  return db;
}

async function seedAccount(db,id){
  await db.execute({
    sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo,is_available)
      VALUES (?,?,?,?,?,0,0)`,
    args:[id,`member-${id}@example.test`,'hash',`Member ${id}`,id%2?'#123456':'#654321'],
  });
}

async function seedCircle(db,{circleId,name=`Circle ${circleId}`,userIds,ownerId=userIds[0]}){
  for(const userId of userIds) await seedAccount(db,userId);
  await db.execute({
    sql:`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by)
      VALUES (?,?,?,?,0,?)`,
    args:[circleId,`circle-${circleId}`,`circle-${circleId}`,name,ownerId],
  });
  for(const userId of userIds){
    await db.execute({
      sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status)
        VALUES (?,?,?,'active')`,args:[circleId,userId,userId===ownerId?'owner':'member'],
    });
  }
}

async function setCurrentAvailability(db,{circleId,userId,isAvailable}){
  const scope={kind:'circle',scopeKey:`circle:${circleId}`,circleId};
  const cycle=resolvePairingCycle({now:NOW,state:'current'});
  const cycleKey=availabilityCycleKey(scope,cycle);
  await db.execute({
    sql:`INSERT INTO pairing_cycles
      (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
      VALUES (?,?,?,?,?,?,?,?, 'cycle_default') ON CONFLICT(scope_key,cycle_key) DO NOTHING`,
    args:[scope.scopeKey,circleId,cycleKey,cycle.cycleId,cycle.startsAt,cycle.endsAt,
      cycle.cutoffAt,cycle.timeZone],
  });
  await db.execute({
    sql:`INSERT INTO pairing_cycle_availability
      (scope_key,cycle_key,user_id,is_available,version,decision_source)
      VALUES (?,?,?,?,1,'user')`,args:[scope.scopeKey,cycleKey,userId,isAvailable?1:0],
  });
}

async function events(db){
  return (await db.execute(`SELECT id,event_type,event_version,idempotency_key,payload_json,status
    FROM outbox_events ORDER BY id`)).rows.map(row=>({...row,payload:JSON.parse(row.payload_json)}));
}

function eventFor(row){
  return {
    id:Number(row.id),eventType:String(row.event_type),eventVersion:Number(row.event_version),
    idempotencyKey:String(row.idempotency_key),payload:row.payload,attemptCount:1,maxAttempts:5,
    deliveryTimeoutMs:10_000,leaseToken:'test-lease',leasedUntil:'2099-01-01T00:00:00.000Z',
  };
}

test('the secondary email flag is default-off and depends on every coordination gate',()=>{
  for(const key of FLAGS) delete process.env[key];
  assert.equal(secondaryCirclePairingEmailEnabled(),false);
  process.env.SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED='true';
  assert.equal(secondaryCirclePairingEmailEnabled(),false);
  for(const key of FLAGS.slice(0,-1)) process.env[key]='true';
  assert.equal(secondaryCirclePairingEmailEnabled(),true);
  delete process.env.MULTI_CIRCLE_AVAILABILITY_ENABLED;
  assert.equal(secondaryCirclePairingEmailEnabled(),false);
});

test('new manual-style publication atomically queues compact v2 paired, solo, and unavailable intents',async()=>{
  const db=await fixture();
  enableSecondaryEmail();
  await seedCircle(db,{circleId:20,name:'Interview Circle',userIds:[1,2,3,4]});
  await setCurrentAvailability(db,{circleId:20,userId:4,isAvailable:false});
  const sessionHash='a'.repeat(64);
  await db.batch([{
    sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at) VALUES (?,1,1,4000000000)`,
    args:[sessionHash],
  },{
    sql:`INSERT INTO auth_session_circle_contexts
      (session_hash,user_id,circle_id,context_version,updated_at) VALUES (?,1,20,7,1)`,
    args:[sessionHash],
  }],'write');
  const authority={kind:'session',payload:{id:1,sessionHash},userId:1,circleId:20,
    contextVersion:7,implicit:false,requireOwner:true};
  const created=await publishCirclePairing(db,{authority,now:NOW});
  const replay=await publishCirclePairing(db,{authority,now:NOW});
  assert.equal(created.created,true);
  assert.equal(replay.created,false);
  const stored=await events(db);
  assert.equal(stored.length,4);
  assert.deepEqual(stored.map(row=>row.payload.kind).sort(),['paired','paired','solo','unavailable']);
  for(const row of stored){
    assert.equal(row.event_type,PAIRING_EMAIL_EVENT_TYPE);
    assert.equal(Number(row.event_version),SECONDARY_PAIRING_EMAIL_EVENT_VERSION);
    assert.deepEqual(Object.keys(row.payload).sort(),['circle_id','kind','publication_id','user_id']);
    assert.equal(row.payload.publication_id,created.publication.id);
    assert.equal(row.payload.circle_id,20);
    assert.equal(JSON.stringify(row.payload).includes('@'),false);
    assert.doesNotMatch(JSON.stringify(row.payload),/Interview|token|credential|content/i);
  }
});

test('flag-off publication is unchanged and writes no secondary notification',async()=>{
  const db=await fixture();
  await seedCircle(db,{circleId:20,userIds:[1,2]});
  process.env.SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED='true';
  const result=await publishCirclePairing(db,{authority:{kind:'system',circleId:20},now:NOW});
  assert.equal(result.created,true);
  assert.equal((await events(db)).length,0);
});

test('cron-style publications isolate circles and dispatch current data to dashboard-only links',async()=>{
  const db=await fixture();
  enableSecondaryEmail();
  await seedCircle(db,{circleId:20,name:'Systems <Circle>',userIds:[1,2,3]});
  await seedCircle(db,{circleId:30,name:'Algorithms Circle',userIds:[4]});
  const first=await publishCirclePairing(db,{authority:{kind:'system',circleId:20},now:NOW});
  const second=await publishCirclePairing(db,{authority:{kind:'system',circleId:30},now:NOW});
  assert.equal(first.created,true);
  assert.equal(second.created,true);
  const queued=await events(db);
  assert.equal(queued.length,4);
  assert.deepEqual(new Set(queued.map(row=>row.payload.circle_id)),new Set([20,30]));
  const messages=[];
  const handler=createPairingEmailHandler({
    db,baseUrl:'https://randori.example.test',send:async message=>{
      messages.push(message);
      return {providerName:'capture',providerMessageId:`message-${messages.length}`};
    },
  });
  const delivered=await runOutboxWorker({
    db,workerId:'secondary-email-test',handlers:{[PAIRING_EMAIL_EVENT_TYPE]:handler},
    eventType:PAIRING_EMAIL_EVENT_TYPE,batchSize:10,leaseDurationMs:1000,heartbeatIntervalMs:0,
  });
  assert.equal(delivered.delivered,4);
  assert.equal(messages.length,4);
  assert.equal(messages.some(message=>message.subject.includes('Systems <Circle>')),true);
  assert.equal(messages.some(message=>message.subject.includes('Algorithms Circle')),true);
  for(const message of messages){
    assert.match(message.html,/href="https:\/\/randori\.example\.test"/);
    assert.doesNotMatch(message.html,/\/join\/|room|workspace|week_[1-9]/i);
    assert.doesNotMatch(message.html,/<Circle>/);
  }
  const duplicate=await runOutboxWorker({
    db,workerId:'secondary-email-test-replay',handlers:{[PAIRING_EMAIL_EVENT_TYPE]:handler},
    eventType:PAIRING_EMAIL_EVENT_TYPE,batchSize:10,leaseDurationMs:1000,heartbeatIntervalMs:0,
  });
  assert.equal(duplicate.claimed,0);
});

test('dispatch suppresses stale scope, membership, partner, circle, preference, and rollout state',async()=>{
  const db=await fixture();
  enableSecondaryEmail();
  await seedCircle(db,{circleId:20,name:'Safe Circle',userIds:[1,2]});
  const result=await publishCirclePairing(db,{authority:{kind:'system',circleId:20},now:NOW});
  const queued=await events(db);
  const forUser=id=>eventFor(queued.find(row=>Number(row.payload.user_id)===id));
  let sends=0;
  const handler=createPairingEmailHandler({db,baseUrl:'https://randori.example.test',
    send:async()=>{ sends+=1; return {providerMessageId:'sent'}; }});

  const malformed={...forUser(1),payload:{...forUser(1).payload,circle_id:30}};
  assert.deepEqual(await handler(malformed),{status:'suppressed',reasonCode:'PUBLICATION_INVALID'});
  const wrongKind={...forUser(1),payload:{...forUser(1).payload,kind:'solo'}};
  assert.deepEqual(await handler(wrongKind),{status:'suppressed',reasonCode:'PUBLICATION_INVALID'});

  await db.execute({sql:`UPDATE circle_pairing_publications SET participant_count=9 WHERE id=?`,
    args:[result.publication.id]});
  assert.deepEqual(await handler(forUser(1)),{status:'suppressed',reasonCode:'PUBLICATION_INVALID'});
  await db.execute({sql:`UPDATE circle_pairing_publications SET participant_count=2 WHERE id=?`,
    args:[result.publication.id]});

  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=20 AND user_id=2`);
  assert.deepEqual(await handler(forUser(1)),{status:'suppressed',reasonCode:'PARTNER_REVOKED'});
  await db.execute(`UPDATE circle_memberships SET status='active' WHERE circle_id=20 AND user_id=2`);
  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=20 AND user_id=1`);
  assert.deepEqual(await handler(forUser(1)),{status:'suppressed',reasonCode:'MEMBERSHIP_REVOKED'});
  await db.execute(`UPDATE circle_memberships SET status='active' WHERE circle_id=20 AND user_id=1`);
  await db.execute(`INSERT INTO user_notification_prefs (user_id,email_enabled) VALUES (1,0)`);
  assert.deepEqual(await handler(forUser(1)),{status:'suppressed',reasonCode:'EMAIL_DISABLED'});
  await db.execute(`UPDATE user_notification_prefs SET email_enabled=1 WHERE user_id=1`);
  await db.execute(`UPDATE circles SET archived_at='2026-09-20T09:00:00.000Z' WHERE id=20`);
  assert.deepEqual(await handler(forUser(1)),{status:'suppressed',reasonCode:'CIRCLE_UNAVAILABLE'});
  await db.execute(`UPDATE circles SET archived_at=NULL WHERE id=20`);
  delete process.env.SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED;
  assert.deepEqual(await handler(forUser(1)),{
    status:'suppressed',reasonCode:'SECONDARY_PAIRING_EMAIL_DISABLED',
  });
  assert.equal(sends,0);
  assert.equal(result.publication.circleId,20);
});

test('v2 parsing rejects unknown versions and non-exact payloads permanently',async()=>{
  const db=await fixture();
  enableSecondaryEmail();
  const handler=createPairingEmailHandler({db,baseUrl:'https://randori.example.test',send:async()=>({})});
  await assert.rejects(()=>handler({eventVersion:3,payload:{}}),error=>
    error?.code==='EVENT_VERSION_UNSUPPORTED'&&error?.retryable===false);
  await assert.rejects(()=>handler({eventVersion:2,payload:{
    publication_id:1,circle_id:2,user_id:3,kind:'paired',recipient_email:'leak@example.test',
  }}),error=>error?.code==='PAYLOAD_INVALID'&&error?.retryable===false);
  await assert.rejects(()=>handler({eventVersion:2,payload:{
    publication_id:1,circle_id:2,user_id:3,kind:'unknown',
  }}),error=>error?.code==='PAYLOAD_INVALID'&&error?.retryable===false);
});

test('secondary notification failure rolls the publication back and a race converges on one event per member',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-secondary-email-race-'));
  const url=`file:${join(directory,'database.sqlite')}`;
  const setup=createClient({url});
  const first=createClient({url});
  const second=createClient({url});
  resources.push(async()=>{
    await Promise.allSettled([setup.close(),first.close(),second.close()]);
    rmSync(directory,{recursive:true,force:true});
  });
  await prepareMigrationConnection(setup);
  const state=await inspectMigrationState(setup);
  await applyMigrations(setup,{expectedStateFingerprint:state.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  await seedCircle(setup,{circleId:20,userIds:[1,2,3,4]});
  enableSecondaryEmail();
  await setup.execute(`CREATE TRIGGER reject_secondary_email BEFORE INSERT ON outbox_events
    WHEN NEW.event_version=2 BEGIN SELECT RAISE(ABORT,'forced notification failure'); END`);
  await assert.rejects(publishCirclePairing(setup,{authority:{kind:'system',circleId:20},now:NOW}));
  assert.equal(Number((await setup.execute(`SELECT COUNT(*) AS count FROM circle_pairing_publications`)).rows[0].count),0);
  assert.equal((await events(setup)).length,0);
  await setup.execute(`DROP TRIGGER reject_secondary_email`);
  await Promise.all([prepareMigrationConnection(first),prepareMigrationConnection(second)]);
  const results=await Promise.all([
    publishCirclePairing(first,{authority:{kind:'system',circleId:20},now:NOW}),
    publishCirclePairing(second,{authority:{kind:'system',circleId:20},now:NOW}),
  ]);
  assert.equal(results.filter(item=>item.created).length,1);
  assert.equal((await events(setup)).length,4);
});
