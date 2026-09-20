import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import { materializeAvailabilityCycle } from '../../api/_availability.js';
import { resolvePairingCycle } from '../../api/_pairing-cycle.js';
import {
  getPairingPublication,
  PairingPublicationError,
  publishPairingCycle,
} from '../../api/_pairing-publication.js';
import {
  PAIRING_SCHEMA_V6_FINGERPRINT,
  pairingSchemaV6Fingerprint,
  pairingSchemaV6Ready,
} from '../../api/_pairing-readiness.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';

const NOW='2026-09-20T07:00:00.000Z';
const APP_URL='https://randori.example.test';
const SCOPE=Object.freeze({kind:'circle',scopeKey:'circle:1',circleId:1});
const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const cleanup=[];

afterEach(async()=>{
  while(cleanup.length){
    const item=cleanup.pop();
    try{ await item(); }catch{}
  }
});

async function createDatabase({migrations=EXECUTABLE_MIGRATIONS}={}){
  const directory=mkdtempSync(join(tmpdir(),'randori-pair-publication-'));
  const url=`file:${join(directory,'pairing.sqlite')}`;
  const db=createClient({url});
  await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(db,{migrations});
  await applyMigrations(db,{
    expectedStateFingerprint:initial.stateFingerprint,migrations,retry:NO_RETRY,
  });
  let closed=false;
  cleanup.push(async()=>{
    if(!closed){ closed=true; await db.close(); }
    rmSync(directory,{recursive:true,force:true});
  });
  return {
    db,url,
    close:async()=>{ if(!closed){ closed=true; await db.close(); } },
    open:async()=>{
      const client=createClient({url});
      await prepareMigrationConnection(client);
      cleanup.push(()=>client.close());
      return client;
    },
  };
}

async function seedCircle(db,accounts,{closeRollout=true,createdBy=1}={}){
  await db.execute({sql:`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by)
    VALUES (1,'circle_test','test-circle','Test Circle',1,?)`,args:[createdBy]});
  for(const account of accounts){
    await db.execute({sql:`INSERT INTO auth_accounts
        (id,email,password_hash,display_name,color,is_available,is_admin,is_demo)
      VALUES (?,?,?,?,?,?,?,?)`,args:[
      account.id,account.email||`person-${account.id}@private.example`,'unused-password-hash',
      account.name||`Person ${account.id}`,'#123456',account.legacyAvailable??1,
      account.role==='owner'?1:0,account.demo?1:0,
    ]});
    if(account.membership!=='none'){
      await db.execute({sql:`INSERT INTO circle_memberships
          (circle_id,user_id,role,status,invited_by)
        VALUES (1,?,?,?,1)`,args:[account.id,account.role||'member',account.membership||'active']});
    }
  }
  if(closeRollout){
    const owner=accounts.find(account=>account.role==='owner'
      &&account.membership!=='none'&&account.membership!=='inactive'&&!account.demo);
    if(!owner) throw new Error('a closed rollout fixture requires an active non-demo owner');
    const creator=accounts.find(account=>account.id===createdBy&&!account.demo);
    if(!creator) throw new Error('a closed rollout fixture requires its non-demo creator');
    await db.execute(`UPDATE circle_membership_rollout SET registrations_closed=1 WHERE id=1`);
    for(const account of accounts.filter(item=>!item.demo)){
      await db.execute({sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key)
        VALUES (1,'membership.backfilled',?,?,?)`,args:[
        creator.id,account.id,`membership-backfilled:1:${account.id}`,
      ]});
    }
    await db.execute({sql:`INSERT INTO circle_audit_events
        (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key)
      VALUES (1,'membership.backfill.completed',?,NULL,'primary-membership-backfill:1:v1')`,
    args:[creator.id]});
  }
}

async function setAvailability(db,{userId,isAvailable,now=NOW}){
  const cycle=resolvePairingCycle({now});
  const record=await materializeAvailabilityCycle(db,{scope:SCOPE,cycle});
  await db.execute({sql:`INSERT INTO pairing_cycle_availability
      (scope_key,cycle_key,user_id,is_available,version,decision_source,created_at,updated_at)
    VALUES (?,?,?,?,1,'user',?,?)`,args:[
    SCOPE.scopeKey,record.cycleKey,userId,isAvailable?1:0,now,now,
  ]});
  return record.cycleKey;
}

function publicationOptions(overrides={}){
  return {
    now:NOW,
    appUrl:APP_URL,
    localRuntime:false,
    callerId:1,
    authorizedScope:SCOPE,
    ...overrides,
  };
}

async function count(db,table){
  const result=await db.execute(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count||0);
}

function assertPairCoverage(publication,expectedIds){
  const ids=[];
  for(const pair of publication.pairs){
    ids.push(pair.aId);
    if(!pair.isAI) ids.push(pair.bId);
    else assert.equal(pair.aId,pair.bId);
  }
  assert.deepEqual(ids.sort((a,b)=>a-b),[...expectedIds].sort((a,b)=>a-b));
}

test('managed-v6 publication safely covers one, two, three, and odd participant counts',async()=>{
  for(const size of [1,2,3,5]){
    const fixture=await createDatabase();
    await seedCircle(fixture.db,Array.from({length:size},(_,index)=>({
      id:index+1,role:index===0?'owner':'member',
    })));
    const result=await publishPairingCycle(fixture.db,publicationOptions());
    assert.equal(result.created,true);
    assert.equal(result.publication.participantCount,size);
    assert.equal(result.publication.participants.length,size);
    assert.equal(result.publication.pairs.length,Math.ceil(size/2));
    assert.equal(result.publication.pairs.filter(pair=>pair.isAI).length,size%2);
    assertPairCoverage(result.publication,Array.from({length:size},(_,index)=>index+1));
    assert.equal(await count(fixture.db,'outbox_events'),size);
    const retentionScopes=await fixture.db.execute(`SELECT scope_key,circle_id,week_id,pair_group_id
      FROM chat_retention_scopes ORDER BY pair_group_id`);
    assert.equal(retentionScopes.rows.length,result.publication.pairs.length);
    assert.ok(retentionScopes.rows.every(row=>row.scope_key==='circle:1'&&Number(row.circle_id)===1));
    assert.equal(Object.isFrozen(result),true);
    assert.doesNotMatch(JSON.stringify(result),/@private\.example|recipient_email|generationToken/i);

    const snapshot=JSON.parse(String((await fixture.db.execute(
      `SELECT participants_json FROM pairing_week_runs`,
    )).rows[0].participants_json));
    assert.equal(snapshot.length,size);
    assert.equal(new Set(snapshot.map(item=>item.availability_cycle_key)).size,1);
    assert.ok(snapshot.every(item=>Number.isSafeInteger(Number(item.availability_version))
      &&['user','legacy_bridge','cycle_default'].includes(item.availability_source)));
  }
});

test('an all-unavailable primary circle publishes one immutable empty cycle',async()=>{
  const fixture=await createDatabase();
  await seedCircle(fixture.db,[{id:1,role:'owner'},{id:2,role:'member'}]);
  await setAvailability(fixture.db,{userId:1,isAvailable:false});
  await setAvailability(fixture.db,{userId:2,isAvailable:false});

  const first=await publishPairingCycle(fixture.db,publicationOptions());
  assert.equal(first.created,true);
  assert.equal(first.publication.participantCount,0);
  assert.deepEqual(first.publication.participants,[]);
  assert.deepEqual(first.publication.pairs,[]);
  assert.equal(await count(fixture.db,'pairing_week_runs'),1);
  assert.equal(await count(fixture.db,'pairing_weeks'),1);
  assert.equal(await count(fixture.db,'pairing_participants'),0);
  assert.equal(await count(fixture.db,'pairing_groups'),0);
  assert.equal(await count(fixture.db,'chat_retention_scopes'),0);

  const evidence=await fixture.db.execute(`SELECT event_type,event_version,idempotency_key,
      json_extract(payload_json,'$.week_id') AS week_id,
      json_extract(payload_json,'$.user_id') AS user_id,
      json_extract(payload_json,'$.kind') AS kind
    FROM outbox_events ORDER BY user_id`);
  assert.deepEqual(evidence.rows.map(row=>({
    event_type:String(row.event_type),event_version:Number(row.event_version),
    idempotency_key:String(row.idempotency_key),week_id:Number(row.week_id),
    user_id:Number(row.user_id),kind:String(row.kind),
  })),[
    {event_type:'pairing.email.requested',event_version:1,
      idempotency_key:`randori/${first.publication.weekId}/unavailable/1`,
      week_id:first.publication.weekId,user_id:1,kind:'unavailable'},
    {event_type:'pairing.email.requested',event_version:1,
      idempotency_key:`randori/${first.publication.weekId}/unavailable/2`,
      week_id:first.publication.weekId,user_id:2,kind:'unavailable'},
  ]);

  const replay=await publishPairingCycle(fixture.db,publicationOptions({
    callerId:null,authorizedScope:null,
  }));
  assert.equal(replay.created,false);
  assert.deepEqual(replay.publication,first.publication);
  assert.equal(await count(fixture.db,'outbox_events'),2,
    'an empty publication retry must keep one idempotent evidence event per unavailable member');

  await fixture.close();
  const restarted=await fixture.open();
  assert.deepEqual(await getPairingPublication(restarted,{now:NOW}),first.publication,
    'an empty publication is durable and readable after restart');
});

test('concurrent empty owner and cron publications retain one claim and one outbox set',async()=>{
  const fixture=await createDatabase();
  await seedCircle(fixture.db,[{id:1,role:'owner'},{id:2,role:'member'}]);
  await setAvailability(fixture.db,{userId:1,isAvailable:false});
  await setAvailability(fixture.db,{userId:2,isAvailable:false});
  await fixture.close();
  const ownerDb=await fixture.open();
  const cronDb=await fixture.open();

  const [owner,cron]=await Promise.all([
    publishPairingCycle(ownerDb,publicationOptions()),
    publishPairingCycle(cronDb,publicationOptions({callerId:null,authorizedScope:null})),
  ]);
  assert.equal(Number(owner.created)+Number(cron.created),1);
  assert.deepEqual(owner.publication,cron.publication);
  assert.equal(owner.publication.participantCount,0);
  assert.equal(await count(ownerDb,'pairing_week_runs'),1);
  assert.equal(await count(ownerDb,'pairing_weeks'),1);
  assert.equal(await count(ownerDb,'pairing_participants'),0);
  assert.equal(await count(ownerDb,'pairing_groups'),0);
  assert.equal(await count(ownerDb,'outbox_events'),2);
});

test('eligibility is the exact active non-demo primary-circle availability snapshot',async()=>{
  const {db}=await createDatabase();
  await seedCircle(db,[
    {id:1,role:'member',membership:'inactive'},
    {id:2,role:'owner'},
    {id:3,role:'member'},
    {id:4,role:'member',membership:'none'},
    {id:5,role:'member',demo:true},
  ]);
  assert.equal(await pairingSchemaV6Ready(db,{requireClosedMembership:true}),true,
    'historically audited inactive and removed members do not invalidate the completed rollout');
  const auditSubjects=await db.execute(`SELECT subject_user_id FROM circle_audit_events
    WHERE event_type='membership.backfilled' ORDER BY subject_user_id`);
  assert.deepEqual(auditSubjects.rows.map(row=>Number(row.subject_user_id)),[1,2,3,4]);
  const cycleKey=await setAvailability(db,{userId:3,isAvailable:false});

  const result=await publishPairingCycle(db,publicationOptions({callerId:2}));
  assert.equal(result.publication.participantCount,1);
  assert.deepEqual(result.publication.participants.map(item=>item.userId),[2]);
  assertPairCoverage(result.publication,[2]);
  const outbox=await db.execute(`SELECT
      json_extract(payload_json,'$.user_id') AS user_id,
      json_extract(payload_json,'$.kind') AS kind,
      json_extract(payload_json,'$.recipient_email') AS recipient_email
    FROM outbox_events ORDER BY user_id`);
  assert.deepEqual(outbox.rows.map(row=>[Number(row.user_id),row.kind]),[
    [2,'paired'],[3,'unavailable'],
  ]);
  assert.ok(outbox.rows.every(row=>!String(row.recipient_email).includes('person-1')
    &&!String(row.recipient_email).includes('person-4')
    &&!String(row.recipient_email).includes('person-5')));
  const snapshot=JSON.parse(String((await db.execute(
    `SELECT participants_json FROM pairing_week_runs`,
  )).rows[0].participants_json));
  assert.equal(snapshot[0].availability_cycle_key,cycleKey);
});

test('owner and cron paths share an immutable no-op publication with no duplicate outbox',async()=>{
  const {db}=await createDatabase();
  await seedCircle(db,[{id:1,role:'owner'},{id:2,role:'member'},{id:3,role:'member'}]);
  const first=await publishPairingCycle(db,publicationOptions());
  const before=(await db.execute(`SELECT generation_token,updated_at FROM pairing_week_runs`)).rows[0];
  await setAvailability(db,{userId:2,isAvailable:false});

  const second=await publishPairingCycle(db,publicationOptions({callerId:null,authorizedScope:null}));
  const after=(await db.execute(`SELECT generation_token,updated_at FROM pairing_week_runs`)).rows[0];
  assert.equal(first.created,true);
  assert.equal(second.created,false);
  assert.deepEqual(second.publication,first.publication);
  assert.deepEqual(after,before);
  assert.equal(await count(db,'pairing_week_runs'),1);
  assert.equal(await count(db,'pairing_weeks'),1);
  assert.equal(await count(db,'pairing_groups'),2);
  assert.equal(await count(db,'pairing_participants'),3);
  assert.equal(await count(db,'outbox_events'),3);
});

test('concurrent owner and cron clients converge on one complete publication',async()=>{
  const fixture=await createDatabase();
  await seedCircle(fixture.db,[
    {id:1,role:'owner'},{id:2,role:'member'},{id:3,role:'member'},{id:4,role:'member'},
  ]);
  await fixture.close();
  const ownerDb=await fixture.open();
  const cronDb=await fixture.open();

  const [owner,cron]=await Promise.all([
    publishPairingCycle(ownerDb,publicationOptions()),
    publishPairingCycle(cronDb,publicationOptions({callerId:null,authorizedScope:null})),
  ]);
  assert.equal(Number(owner.created)+Number(cron.created),1);
  assert.deepEqual(owner.publication,cron.publication);
  assertPairCoverage(owner.publication,[1,2,3,4]);
  assert.equal(await count(ownerDb,'pairing_week_runs'),1);
  assert.equal(await count(ownerDb,'pairing_weeks'),1);
  assert.equal(await count(ownerDb,'pairing_participants'),4);
  assert.equal(await count(ownerDb,'pairing_groups'),2);
  assert.equal(await count(ownerDb,'chat_retention_scopes'),2);
  assert.equal(await count(ownerDb,'outbox_events'),4);
});

test('a mid-write failure rolls back cycle, claim, participants, groups, and outbox',async()=>{
  const fixture=await createDatabase();
  await seedCircle(fixture.db,[{id:1,role:'owner'},{id:2,role:'member'}]);
  const wrapped={
    execute:fixture.db.execute.bind(fixture.db),
    batch:fixture.db.batch.bind(fixture.db),
    async transaction(mode){
      const transaction=await fixture.db.transaction(mode);
      return {
        execute:transaction.execute.bind(transaction),
        async batch(statements,batchMode){
          if(batchMode!=='write') return transaction.batch(statements,batchMode);
          for(const statement of statements.slice(0,5)) await transaction.execute(statement);
          throw new Error('forced publication write failure');
        },
        commit:transaction.commit.bind(transaction),
        rollback:transaction.rollback.bind(transaction),
        close:transaction.close?.bind(transaction),
      };
    },
  };

  await assert.rejects(
    publishPairingCycle(wrapped,publicationOptions()),
    error=>error instanceof PairingPublicationError
      &&error.code==='PAIRING_PUBLICATION_FAILED'
      &&!JSON.stringify(error).includes('@private.example'),
  );
  for(const table of [
    'pairing_cycles','pairing_week_runs','pairing_weeks','pairing_participants',
    'pairing_groups','chat_retention_scopes','outbox_events',
  ]) assert.equal(await count(fixture.db,table),0,table);
});

test('managed schema v6 and an explicit safe app URL are required before mutation',async()=>{
  const stale=await createDatabase({migrations:EXECUTABLE_MIGRATIONS.slice(0,3)});
  await assert.rejects(
    publishPairingCycle(stale.db,publicationOptions()),
    error=>error instanceof PairingPublicationError
      &&error.code==='PAIRING_PUBLICATION_SCHEMA_UNAVAILABLE',
  );
  assert.equal(await count(stale.db,'pairing_week_runs'),0);

  const current=await createDatabase();
  let transactionCount=0;
  const wrapped={
    execute:current.db.execute.bind(current.db),
    batch:current.db.batch.bind(current.db),
    async transaction(mode){ transactionCount+=1; return current.db.transaction(mode); },
  };
  for(const appUrl of [undefined,'http://randori.example.test','https://user:pass@randori.example.test','https://randori.example.test/path']){
    await assert.rejects(
      publishPairingCycle(wrapped,publicationOptions({appUrl})),
      error=>error instanceof PairingPublicationError
        &&error.code==='PAIRING_PUBLICATION_CONFIG_INVALID',
    );
  }
  assert.equal(transactionCount,0);
});

test('production publication requires a complete closed membership rollout',async()=>{
  const open=await createDatabase();
  assert.equal(await pairingSchemaV6Ready(open.db,{requireClosedMembership:true}),false);
  await assert.rejects(
    publishPairingCycle(open.db,publicationOptions()),
    error=>error instanceof PairingPublicationError
      &&error.code==='PAIRING_PUBLICATION_SCHEMA_UNAVAILABLE',
  );

  const partial=await createDatabase();
  await seedCircle(partial.db,[
    {id:1,role:'owner'},
    {id:2,role:'member',membership:'inactive'},
    {id:3,role:'member',membership:'none'},
  ],{closeRollout:false});
  assert.equal(await pairingSchemaV6Ready(partial.db,{requireClosedMembership:true}),false);
  await assert.rejects(
    publishPairingCycle(partial.db,publicationOptions()),
    error=>error instanceof PairingPublicationError
      &&error.code==='PAIRING_PUBLICATION_SCHEMA_UNAVAILABLE',
  );
  assert.equal(await count(partial.db,'pairing_week_runs'),0);
  assert.equal(await count(partial.db,'pairing_cycles'),0);

  const closedInvalid=await createDatabase();
  await seedCircle(closedInvalid.db,[{id:1,role:'owner'},{id:2,role:'member'}],{
    closeRollout:false,
  });
  await closedInvalid.db.execute(
    `UPDATE circle_membership_rollout SET registrations_closed=1 WHERE id=1`,
  );
  await closedInvalid.db.execute(`INSERT INTO circle_audit_events
      (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key)
    VALUES (1,'membership.backfill.completed',1,NULL,'primary-membership-backfill:1:v1')`);
  assert.equal(await pairingSchemaV6Ready(closedInvalid.db,{requireClosedMembership:true}),false);
  await assert.rejects(
    publishPairingCycle(closedInvalid.db,publicationOptions()),
    error=>error instanceof PairingPublicationError
      &&error.code==='PAIRING_PUBLICATION_SCHEMA_UNAVAILABLE',
  );
  assert.equal(await count(closedInvalid.db,'pairing_week_runs'),0);

  const closedValid=await createDatabase();
  await seedCircle(closedValid.db,[{id:1,role:'owner'},{id:2,role:'member'}]);
  assert.equal(await pairingSchemaV6Ready(closedValid.db,{requireClosedMembership:true}),true);
  await closedValid.db.execute(`UPDATE circle_audit_events SET actor_user_id=999
    WHERE event_type='membership.backfill.completed'`);
  assert.equal(await pairingSchemaV6Ready(closedValid.db,{requireClosedMembership:true}),false,
    'a nonexistent completion actor is rejected');
  await closedValid.db.execute(`UPDATE circle_audit_events SET actor_user_id=2
    WHERE event_type='membership.backfill.completed'`);
  assert.equal(await pairingSchemaV6Ready(closedValid.db,{requireClosedMembership:true}),false,
    'a completion actor different from the primary-circle creator is rejected');
  await closedValid.db.execute(`UPDATE circle_audit_events SET actor_user_id=1
    WHERE event_type='membership.backfill.completed'`);
  await closedValid.db.execute(`UPDATE circle_audit_events SET actor_user_id=999
    WHERE event_type='membership.backfilled' AND subject_user_id=2`);
  assert.equal(await pairingSchemaV6Ready(closedValid.db,{requireClosedMembership:true}),false,
    'a nonexistent backfill actor is rejected');
  await closedValid.db.execute(`UPDATE circle_audit_events SET actor_user_id=2
    WHERE event_type='membership.backfilled' AND subject_user_id=2`);
  assert.equal(await pairingSchemaV6Ready(closedValid.db,{requireClosedMembership:true}),false,
    'backfill actors must match the completion actor and primary-circle creator');
  await closedValid.db.execute(`UPDATE circle_audit_events SET actor_user_id=1
    WHERE event_type='membership.backfilled' AND subject_user_id=2`);
  assert.equal(await pairingSchemaV6Ready(closedValid.db,{requireClosedMembership:true}),true);
  const published=await publishPairingCycle(closedValid.db,publicationOptions());
  assert.equal(published.created,true);
  assert.equal(published.publication.participantCount,2);
});

test('readiness pins the complete managed-v6 structure, ledger, and connection guards',async()=>{
  const {db}=await createDatabase();
  assert.equal(await pairingSchemaV6Fingerprint(db),PAIRING_SCHEMA_V6_FINGERPRINT);
  assert.equal(await pairingSchemaV6Ready(db),true);

  await db.execute(`UPDATE schema_migrations SET checksum='${'0'.repeat(64)}' WHERE version=3`);
  assert.equal(await pairingSchemaV6Ready(db),false,'a changed immutable ledger row is stale');
  await db.execute({
    sql:`UPDATE schema_migrations SET checksum=? WHERE version=3`,
    args:[EXECUTABLE_MIGRATIONS[2].checksum],
  });
  assert.equal(await pairingSchemaV6Ready(db),true);

  const futureVersion=Math.max(...EXECUTABLE_MIGRATIONS.map(migration=>migration.version))+1;
  await db.execute({sql:`INSERT INTO schema_migrations
      (version,name,checksum,execution_ms,disposition) VALUES (?,'future-migration',?,0,'applied')`,
    args:[futureVersion,'f'.repeat(64)]});
  assert.equal(await pairingSchemaV6Ready(db),false,'a future ledger version is rejected');
  await db.execute({sql:`DELETE FROM schema_migrations WHERE version=?`,args:[futureVersion]});
  assert.equal(await pairingSchemaV6Ready(db),true);

  await db.execute(`CREATE TABLE future_auth_metadata (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`);
  await db.execute(`CREATE INDEX idx_future_auth_metadata_account
    ON future_auth_metadata(account_id)`);
  await db.execute(`CREATE INDEX idx_future_auth_email_lookup ON auth_accounts(email)`);
  assert.equal(await pairingSchemaV6Fingerprint(db),PAIRING_SCHEMA_V6_FINGERPRINT,
    'additive future tables and indexes do not invalidate the managed-v6 projection');
  assert.equal(await pairingSchemaV6Ready(db),true,
    'pairing remains ready after unrelated additive schema changes');

  await db.execute(`CREATE UNIQUE INDEX unexpected_user_once
    ON pairing_participants(user_id)`);
  assert.equal(await pairingSchemaV6Ready(db),false,
    'an unknown unique index that can reject future publications is schema drift');
  await db.execute(`DROP INDEX unexpected_user_once`);
  assert.equal(await pairingSchemaV6Ready(db),true);

  await db.execute(`CREATE TRIGGER unexpected_pairing_trigger AFTER INSERT ON pairing_weeks
    BEGIN SELECT 1; END`);
  assert.equal(await pairingSchemaV6Ready(db),false,'unexpected mutation hooks are schema drift');
  await db.execute(`DROP TRIGGER unexpected_pairing_trigger`);
  assert.equal(await pairingSchemaV6Ready(db),true);

  const membershipSql=String((await db.execute(`SELECT sql FROM sqlite_schema
    WHERE type='table' AND name='circle_memberships'`)).rows[0].sql);
  const weakenedSql=membershipSql.replace(
    "CHECK(role IN ('owner','member'))",
    "CHECK(role IN ('owner','member','admin'))",
  );
  assert.notEqual(weakenedSql,membershipSql);
  await db.execute('PRAGMA writable_schema=ON');
  await db.execute({sql:`UPDATE sqlite_schema SET sql=? WHERE type='table' AND name='circle_memberships'`,args:[weakenedSql]});
  await db.execute('PRAGMA writable_schema=OFF');
  assert.equal(await pairingSchemaV6Ready(db),false,'changed CHECK SQL is schema drift');
  await db.execute('PRAGMA writable_schema=ON');
  await db.execute({sql:`UPDATE sqlite_schema SET sql=? WHERE type='table' AND name='circle_memberships'`,args:[membershipSql]});
  await db.execute('PRAGMA writable_schema=OFF');
  assert.equal(await pairingSchemaV6Ready(db),true);

  await db.execute('PRAGMA foreign_keys=OFF');
  assert.equal(await pairingSchemaV6Ready(db),false);
});

test('readiness rejects missing provider identity and revocable session structures',async()=>{
  for(const object of [
    {type:'TABLE',name:'auth_provider_identities'},
    {type:'TABLE',name:'auth_sessions'},
    {type:'INDEX',name:'idx_auth_sessions_user_active'},
  ]){
    const {db}=await createDatabase();
    await db.execute(`DROP ${object.type} ${object.name}`);
    assert.equal(await pairingSchemaV6Ready(db),false,
      `missing ${object.name} must fail the managed-v6 readiness projection`);
  }
});

test('an ordinary member is denied and owner authorization is rechecked in the transaction',async()=>{
  const {db}=await createDatabase();
  await seedCircle(db,[{id:1,role:'owner'},{id:2,role:'member'}]);
  await assert.rejects(
    publishPairingCycle(db,publicationOptions({callerId:2})),
    error=>error instanceof PairingPublicationError&&error.code==='PAIRING_PUBLISHER_REVOKED',
  );
  await assert.rejects(
    publishPairingCycle(db,publicationOptions({
      authorizedScope:{kind:'circle',scopeKey:'circle:99',circleId:99},
    })),
    error=>error instanceof PairingPublicationError&&error.code==='PAIRING_PUBLISHER_REVOKED',
  );
  assert.equal(await count(db,'pairing_week_runs'),0);
});

test('selected primary publication revalidates the exact session context in its write transaction',async()=>{
  const {db}=await createDatabase();
  await seedCircle(db,[{id:1,role:'owner'},{id:2,role:'member'}]);
  const sessionHash='c'.repeat(64);
  await db.execute({
    sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at)
      VALUES (?,1,1,4000000000)`,args:[sessionHash],
  });
  await db.execute({
    sql:`INSERT INTO auth_session_circle_contexts
      (session_hash,user_id,circle_id,context_version,updated_at) VALUES (?,1,1,7,1)`,
    args:[sessionHash],
  });
  const circleContext={payload:{id:1,sessionHash},circleId:1,contextVersion:7,implicit:false};
  const result=await publishPairingCycle(db,publicationOptions({circleContext}));
  assert.equal(result.created,true);
  await db.execute({
    sql:`UPDATE auth_session_circle_contexts SET context_version=8 WHERE session_hash=? AND user_id=1`,
    args:[sessionHash],
  });
  await assert.rejects(
    publishPairingCycle(db,publicationOptions({circleContext})),
    error=>error instanceof PairingPublicationError&&error.code==='PAIRING_CONTEXT_CHANGED',
  );
  assert.equal(await count(db,'pairing_week_runs'),1);
});

test('publication uses exact Sunday, DST, and ISO-year cycle boundaries',async()=>{
  const cases=[
    ['2026-03-29T06:59:59.999Z','2026-W13','2026-03-22T08:00:00.000Z'],
    ['2026-03-29T07:00:00.000Z','2026-W14','2026-03-29T07:00:00.000Z'],
    ['2026-10-25T08:00:00.000Z','2026-W44','2026-10-25T08:00:00.000Z'],
    ['2027-01-03T08:00:00.000Z','2027-W01','2027-01-03T08:00:00.000Z'],
  ];
  for(const [now,cycleId,startsAt] of cases){
    const {db}=await createDatabase();
    await seedCircle(db,[{id:1,role:'owner'}]);
    const result=await publishPairingCycle(db,publicationOptions({now}));
    assert.equal(result.publication.cycle.cycleId,cycleId);
    assert.equal(result.publication.cycle.startsAt,startsAt);
    const stored=await getPairingPublication(db,{now});
    assert.deepEqual(stored,result.publication);
  }
});

test('verified loopback transport does not weaken circle publication scope or readiness',async()=>{
  const {db}=await createDatabase();
  await seedCircle(db,[{id:1,role:'owner'},{id:2,role:'member'}]);
  await assert.rejects(
    publishPairingCycle(db,publicationOptions({appUrl:'http://127.0.0.1:3000'})),
    error=>error instanceof PairingPublicationError
      &&error.code==='PAIRING_PUBLICATION_CONFIG_INVALID',
  );
  const result=await publishPairingCycle(db,publicationOptions({
    appUrl:'http://127.0.0.1:3000',allowLocalAppUrl:true,
  }));
  assert.equal(result.created,true);
  assert.equal(result.appUrl,'http://127.0.0.1:3000');
  assert.equal(result.publication.participantCount,2);
  assert.deepEqual(result.publication.participants.map(row=>row.userId),[1,2]);
});

test('stale, current, and future publications stay cycle-scoped across a file database restart',async()=>{
  const fixture=await createDatabase();
  await seedCircle(fixture.db,[
    {id:1,role:'owner'},{id:2,role:'member'},{id:3,role:'member'},
  ]);
  const windows=[
    {now:'2026-09-13T08:00:00.000Z',cycleId:'2026-W38'},
    {now:'2026-09-20T08:00:00.000Z',cycleId:'2026-W39'},
    {now:'2026-09-27T08:00:00.000Z',cycleId:'2026-W40'},
  ];
  const publications=[];
  for(const window of windows){
    const result=await publishPairingCycle(fixture.db,publicationOptions({now:window.now}));
    assert.equal(result.created,true);
    assert.equal(result.publication.cycle.cycleId,window.cycleId);
    assertPairCoverage(result.publication,[1,2,3]);
    publications.push(result.publication);
  }
  assert.equal(await count(fixture.db,'pairing_week_runs'),3);
  assert.equal(await count(fixture.db,'outbox_events'),9);
  const originalOutbox=(await fixture.db.execute(
    'SELECT idempotency_key,payload_json FROM outbox_events ORDER BY idempotency_key',
  )).rows;
  assert.equal(originalOutbox.length,9);
  for(const row of originalOutbox){
    const payload=JSON.parse(row.payload_json);
    assert.equal(row.idempotency_key,
      `randori/${payload.week_id}/${payload.kind}/${payload.user_id}`);
  }

  await fixture.close();
  const restarted=await fixture.open();
  for(const [index,window] of windows.entries()){
    assert.deepEqual(await getPairingPublication(restarted,{now:window.now}),publications[index]);
  }
  const repeat=await publishPairingCycle(restarted,publicationOptions({now:windows[1].now}));
  assert.equal(repeat.created,false);
  assert.deepEqual(repeat.publication,publications[1]);
  assert.equal(await count(restarted,'pairing_week_runs'),3);
  assert.equal(await count(restarted,'outbox_events'),9,
    'restart and repeat publication must not duplicate reminders');
  assert.deepEqual((await restarted.execute(
    'SELECT idempotency_key FROM outbox_events ORDER BY idempotency_key',
  )).rows,originalOutbox.map(row=>({idempotency_key:row.idempotency_key})),
  'restart and repeat publication preserve every stable provider idempotency key');
});

test('the production write path contains no destructive remix or request-time DDL',async()=>{
  const fixture=await createDatabase();
  await seedCircle(fixture.db,[{id:1,role:'owner'},{id:2,role:'member'}]);
  const statements=[];
  const wrapped={
    execute:fixture.db.execute.bind(fixture.db),
    batch:fixture.db.batch.bind(fixture.db),
    async transaction(mode){
      const transaction=await fixture.db.transaction(mode);
      return {
        async execute(statement){
          statements.push(typeof statement==='string'?statement:String(statement.sql||''));
          return transaction.execute(statement);
        },
        async batch(batchStatements,batchMode){
          statements.push(...batchStatements.map(statement=>typeof statement==='string'?statement:String(statement.sql||'')));
          return transaction.batch(batchStatements,batchMode);
        },
        commit:transaction.commit.bind(transaction),
        rollback:transaction.rollback.bind(transaction),
        close:transaction.close?.bind(transaction),
      };
    },
  };
  await publishPairingCycle(wrapped,publicationOptions());
  const sql=statements.join('\n');
  assert.doesNotMatch(sql,/\bDELETE\b|ON\s+CONFLICT[^\n]*DO\s+UPDATE/i);
  assert.doesNotMatch(sql,/^\s*(?:CREATE|ALTER|DROP)\b/im);
  assert.match(sql,/generation_token=\?/);
  assert.match(sql,/pairing_cycle_availability/);
});
