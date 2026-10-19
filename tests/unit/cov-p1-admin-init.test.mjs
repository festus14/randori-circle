import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,test} from 'node:test';
import {createClient} from '@libsql/client';

import {
  AdminInitializationError,
  initializeLocalPrimaryCircleData,
  initializePrimaryCircleData,
} from '../../api/_admin-init.js';
import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const NOW_SECONDS=1_800_000_000;
const SESSION_HASH='b'.repeat(64);
const UUID='22222222-2222-4222-8222-222222222222';
const resources=[];

afterEach(async()=>{
  while(resources.length) await resources.pop()();
});

function sqlText(statement){
  return String(typeof statement==='string'?statement:statement?.sql||'').trim();
}

async function databaseFixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-cov-admin-init-'));
  resources.push(()=>rmSync(directory,{recursive:true,force:true}));
  const db=createClient({url:`file:${join(directory,'database.sqlite')}`});
  resources.push(()=>db.close());
  await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(db,{migrations:EXECUTABLE_MIGRATIONS});
  await applyMigrations(db,{
    migrations:EXECUTABLE_MIGRATIONS,expectedStateFingerprint:initial.stateFingerprint,retry:NO_RETRY,
  });
  return db;
}

async function seed(db,{adminFlag=1,email='owner@example.test'}={}){
  await db.execute({
    sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo)
      VALUES (1,?,'x','Owner','#111111',?,0),(2,'Member@Example.test','x','Member','#222222',0,0)`,
    args:[email,adminFlag],
  });
  await db.execute({
    sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at) VALUES (?,1,?,?)`,
    args:[SESSION_HASH,NOW_SECONDS-60,NOW_SECONDS+3600],
  });
}

// Wraps a real transaction; `override(sql)` may return a fake result for a
// statement to simulate a concurrent change or a corrupt row.
function wrapped(db,{override=()=>undefined,rollbackThrows=false,closeThrows=false,commitThrows=false}={}){
  const events=[];
  return {
    events,
    async transaction(mode){
      const transaction=await db.transaction(mode);
      return {
        async execute(statement){
          const fake=override(sqlText(statement));
          if(fake!==undefined) return fake;
          return transaction.execute(statement);
        },
        async commit(){
          events.push('commit');
          if(commitThrows) throw new Error('commit lost');
          return transaction.commit();
        },
        async rollback(){
          events.push('rollback');
          await transaction.rollback();
          if(rollbackThrows) throw new Error('rollback failed');
        },
        close(){
          events.push('close');
          transaction.close();
          if(closeThrows) throw new Error('close failed');
        },
      };
    },
  };
}

function options(overrides={}){
  return {actor:{userId:1,sessionHash:SESSION_HASH},adminEmails:[],nowSeconds:NOW_SECONDS,
    randomUuid:()=>UUID,...overrides};
}

async function rolloutClosed(db){
  const result=await db.execute('SELECT registrations_closed FROM circle_membership_rollout WHERE id=1');
  return Number(result.rows[0].registrations_closed);
}

async function circleCount(db){
  return Number((await db.execute('SELECT COUNT(*) AS n FROM circles')).rows[0].n);
}

test('invalid input is rejected before any transaction is opened',async()=>{
  let opened=0;
  const db={async transaction(){ opened+=1; throw new Error('should not open'); }};
  const bad=[
    options({actor:null}),
    options({actor:{userId:0,sessionHash:SESSION_HASH}}),
    options({actor:{userId:'01',sessionHash:SESSION_HASH}}),
    options({actor:{userId:1.5,sessionHash:SESSION_HASH}}),
    options({actor:{userId:1,sessionHash:'short'}}),
    options({nowSeconds:0}),
    options({nowSeconds:1.5}),
    options({randomUuid:'not-a-function'}),
  ];
  for(const input of bad){
    await assert.rejects(initializePrimaryCircleData(db,input),TypeError);
  }
  await assert.rejects(initializePrimaryCircleData(null,options()),TypeError);
  await assert.rejects(initializePrimaryCircleData({},options()),TypeError);
  await assert.rejects(initializePrimaryCircleData(db,options({adminEmails:'a@b.test'})),
    /adminEmails must be an array/);
  assert.equal(opened,0);
});

test('actor ids are accepted from id or uid aliases and as canonical strings',async()=>{
  const db=await databaseFixture();
  await seed(db);
  const result=await initializePrimaryCircleData(db,options({actor:{uid:'1',sessionHash:SESSION_HASH}}));
  assert.deepEqual(result,{ok:true,circleId:1,changed:true});
  // Second call through the `id` alias is a read-only no-op.
  const again=await initializePrimaryCircleData(db,options({actor:{id:1,sessionHash:SESSION_HASH}}));
  assert.deepEqual(again,{ok:true,circleId:1,changed:false});
});

test('configured owner emails are normalized and grant admin without the admin flag',async()=>{
  const db=await databaseFixture();
  await seed(db,{adminFlag:0,email:' Owner@Example.test '});
  // Non-admin, not configured: refused without writes.
  assert.deepEqual(await initializePrimaryCircleData(db,options({adminEmails:['someone@example.test',null,'']})),
    {ok:false,reason:'admin_required',email:'owner@example.test'});
  assert.equal(await circleCount(db),0);

  const result=await initializePrimaryCircleData(db,options({adminEmails:['  OWNER@example.TEST ','member@example.test']}));
  assert.equal(result.changed,true);
  const roles=await db.execute('SELECT user_id,role FROM circle_memberships ORDER BY user_id');
  assert.deepEqual(roles.rows.map(row=>[Number(row.user_id),String(row.role)]),[[1,'owner'],[2,'owner']]);
});

test('a session for another user or a duplicated account row requires authentication',async()=>{
  const db=await databaseFixture();
  await seed(db);
  assert.deepEqual(await initializePrimaryCircleData(db,options({actor:{userId:2,sessionHash:SESSION_HASH}})),
    {ok:false,reason:'authentication_required'});
  const duplicated=wrapped(db,{override:sql=>/FROM auth_sessions session/.test(sql)
    ?{rows:[{id:1,email:'owner@example.test',is_admin:1,is_demo:0},{id:1}]}:undefined});
  assert.deepEqual(await initializePrimaryCircleData(duplicated,options()),{ok:false,reason:'authentication_required'});
  assert.deepEqual(duplicated.events,['rollback','close']);
  // A row with a missing email is treated as an empty address, never as a configured owner.
  const blankEmail=wrapped(db,{override:sql=>/FROM auth_sessions session/.test(sql)
    ?{rows:[{id:1,email:null,is_admin:0,is_demo:0}]}:undefined});
  assert.deepEqual(await initializePrimaryCircleData(blankEmail,options({adminEmails:['']})),
    {ok:false,reason:'admin_required',email:''});
  assert.equal(await circleCount(db),0);
});

test('local initialization needs no session and checks the account directly',async()=>{
  const db=await databaseFixture();
  await seed(db,{adminFlag:0});
  assert.deepEqual(await initializeLocalPrimaryCircleData(db,{ownerUserId:1,randomUuid:()=>UUID}),
    {ok:false,reason:'admin_required',email:'owner@example.test'});
  assert.deepEqual(await initializeLocalPrimaryCircleData(db,{ownerUserId:3,ownerEmails:['owner@example.test'],
    randomUuid:()=>UUID}),{ok:false,reason:'authentication_required'});
  assert.deepEqual(await initializeLocalPrimaryCircleData(db,{ownerUserId:1,ownerEmails:['owner@example.test'],
    randomUuid:()=>UUID}),{ok:true,circleId:1,changed:true});
  await assert.rejects(initializeLocalPrimaryCircleData(db),TypeError);
});

const FAILURES=[
  ['missing rollout row',/FROM circle_membership_rollout WHERE id=1/,{rows:[]},/rollout state is unavailable/],
  ['unknown rollout value',/FROM circle_membership_rollout WHERE id=1/,{rows:[{registrations_closed:7}]},/rollout state is unavailable/],
  ['bad database time',/AS now_utc/,{rows:[{now_utc:'yesterday'}]},/Database time is unavailable/],
  ['missing database time',/AS now_utc/,{},/Database time is unavailable/],
  ['circle insert returned nothing',/INSERT INTO circles/,{rows:[]},/Primary circle was not created/],
  ['membership backfill omitted the actor',/INSERT INTO circle_memberships/,{rows:[{user_id:2}]},/membership backfill failed/],
  ['membership backfill returned a bad id',/INSERT INTO circle_memberships/,{rows:[{user_id:1},{user_id:'x'}]},/membership backfill failed/],
  ['audit backfill count mismatch',/membership\.backfilled/,{rows:[]},/audit backfill failed/],
  ['completion audit missing',/membership\.backfill\.completed',\?/,{rows:[]},/completion audit failed/],
  ['rollout changed concurrently',/UPDATE circle_membership_rollout/,{rows:[]},/rollout changed during initialization/],
];

for(const [name,pattern,fake,message] of FAILURES){
  test(`fails closed and rolls back when ${name}`,async()=>{
    const db=await databaseFixture();
    await seed(db);
    const client=wrapped(db,{override:sql=>pattern.test(sql)?fake:undefined});
    await assert.rejects(initializePrimaryCircleData(client,options()),error=>
      error instanceof AdminInitializationError&&message.test(error.message)
      &&error.code==='ADMIN_INITIALIZATION_UNAVAILABLE'&&error.commitStarted===false);
    assert.deepEqual(client.events,['rollback','close']);
    assert.equal(await rolloutClosed(db),0);
    assert.equal(await circleCount(db),0);
  });
}

test('an invalid generated circle identity is refused before any write',async()=>{
  const db=await databaseFixture();
  await seed(db);
  await assert.rejects(initializePrimaryCircleData(db,options({randomUuid:()=>'not-a-uuid'})),
    /identity generation failed/);
  // Upper-case v4 UUIDs are normalized rather than rejected.
  const ok=await initializePrimaryCircleData(db,options({randomUuid:()=>UUID.toUpperCase()}));
  assert.equal(ok.changed,true);
  const circle=await db.execute('SELECT public_id FROM circles');
  assert.equal(String(circle.rows[0].public_id),UUID);
});

test('a failed postcondition check aborts the cutover before commit',async()=>{
  const db=await databaseFixture();
  await seed(db);
  // Make the completed-rollout inspector see an extra primary circle.
  const client=wrapped(db,{override:sql=>/WHERE is_primary=1 AND archived_at IS NULL ORDER BY id LIMIT 2/.test(sql)
    ?{rows:[{id:1},{id:2}]}:undefined});
  await assert.rejects(initializePrimaryCircleData(client,options()),/postcondition failed/);
  assert.equal(client.events.includes('commit'),false);
  assert.equal(await rolloutClosed(db),0);
});

test('a closed rollout without exactly one primary circle is unavailable',async()=>{
  const db=await databaseFixture();
  await seed(db);
  await initializePrimaryCircleData(db,options());
  for(const fake of [{rows:[]},{rows:[{id:1},{id:2}]},{rows:[{id:'bad'}]}]){
    const client=wrapped(db,{override:sql=>/SELECT id FROM circles/.test(sql)?fake:undefined});
    await assert.rejects(initializePrimaryCircleData(client,options()),/Primary circle is unavailable/);
  }
});

test('database readiness failures and unexpected errors are wrapped without leaking',async()=>{
  const notReady={async transaction(){
    return {execute:async()=>{ throw new Error('no such table: schema_migrations'); },
      rollback:async()=>{},close(){}};
  }};
  await assert.rejects(initializePrimaryCircleData(notReady,options()),error=>
    error instanceof AdminInitializationError&&error.commitStarted===false);

  const openFails={async transaction(){ throw new Error('SQLITE_BUSY'); }};
  await assert.rejects(initializePrimaryCircleData(openFails,options()),error=>
    error instanceof AdminInitializationError&&error.message==='Admin initialization is unavailable.'
    &&error.cause?.message==='SQLITE_BUSY');
});

test('rollback and close failures never mask the original outcome',async()=>{
  const db=await databaseFixture();
  await seed(db);
  const failing=wrapped(db,{rollbackThrows:true,closeThrows:true,
    override:sql=>/UPDATE circle_membership_rollout/.test(sql)?{rows:[]}:undefined});
  await assert.rejects(initializePrimaryCircleData(failing,options()),/rollout changed during initialization/);
  assert.deepEqual(failing.events,['rollback','close']);

  const refused=wrapped(db,{rollbackThrows:true,closeThrows:true});
  assert.deepEqual(await initializePrimaryCircleData(refused,options({actor:{userId:2,sessionHash:SESSION_HASH}})),
    {ok:false,reason:'authentication_required'});
});

test('a failure during commit is reported with commitStarted so callers do not retry blindly',async()=>{
  const db=await databaseFixture();
  await seed(db);
  const client=wrapped(db,{commitThrows:true});
  await assert.rejects(initializePrimaryCircleData(client,options()),error=>
    error instanceof AdminInitializationError&&error.commitStarted===true
    &&error.cause?.message==='commit lost');
  assert.deepEqual(client.events,['commit','rollback','close']);
});
