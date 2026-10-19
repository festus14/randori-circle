import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,test} from 'node:test';

import {createClient} from '@libsql/client';
import bcrypt from 'bcryptjs';

import {
  consumePasswordReset,
  createPasswordResetHandler,
  deliverPasswordResets,
  ensurePasswordResetReadiness,
  hashPasswordResetToken,
  openPasswordResetToken,
  passwordResetConfiguration,
  passwordResetKeyRing,
  passwordResetStatus,
  requestPasswordReset,
  sealPasswordResetToken,
} from '../../api/_password-reset.js';
import {OutboxDeliveryError} from '../../api/_outbox.js';
import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';
import {adoptCredentialKeyControl} from '../support/credential-key-control.mjs';

const JWT_SECRET='cov-p1-password-reset-secret-at-least-thirty-two-bytes';
const ENCRYPTION_KEY=Buffer.alloc(32,23).toString('base64url');
const NOW=Math.floor(Date.now()/1000);
const ENV_KEYS=['JWT_SECRET','PASSWORD_RESET_ENCRYPTION_KEY','PASSWORD_RESET_ENABLED','CIRCLE_MEMBERSHIP_ENABLED',
  'APP_URL','NODE_ENV','RESEND_API_KEY','RESEND_FROM','PASSWORD_RESET_ENVELOPE_WRITE_VERSION'];
const savedEnv=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
const resources=[];

afterEach(()=>{
  for(const key of ENV_KEYS){
    if(savedEnv[key]===undefined) delete process.env[key]; else process.env[key]=savedEnv[key];
  }
  while(resources.length){ try{ resources.pop()(); }catch{} }
});

function baseEnv(){
  process.env.JWT_SECRET=JWT_SECRET;
  process.env.PASSWORD_RESET_ENCRYPTION_KEY=ENCRYPTION_KEY;
  process.env.PASSWORD_RESET_ENABLED='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  process.env.APP_URL='https://randori.example.test';
  delete process.env.NODE_ENV;
}

async function emptyDatabase(){
  const directory=mkdtempSync(join(tmpdir(),'randori-cov-p1-reset-'));
  const db=createClient({url:`file:${join(directory,'reset.sqlite')}`});
  resources.push(()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  return db;
}

async function fixture({adopt=true}={}){
  baseEnv();
  const db=await emptyDatabase();
  await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:initial.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  if(adopt) await adoptCredentialKeyControl(db,passwordResetKeyRing());
  await db.execute({sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin)
    VALUES (1,?,?,?,?,0)`,args:['member@example.test',await bcrypt.hash('old correct horse',4),'Member','#123456']});
  return db;
}

async function latestEvent(db){
  const row=(await db.execute(`SELECT id,event_type,event_version,idempotency_key,payload_json FROM outbox_events
    WHERE event_type='auth.passwordreset.requested' ORDER BY id DESC LIMIT 1`)).rows[0];
  return {id:Number(row.id),eventType:String(row.event_type),eventVersion:Number(row.event_version),
    idempotencyKey:String(row.idempotency_key),payload:JSON.parse(String(row.payload_json))};
}

async function requestedToken(db){
  assert.equal((await requestPasswordReset(db,{email:'member@example.test'},{nowSeconds:NOW})).accepted,true);
  const event=await latestEvent(db);
  return {event,token:openPasswordResetToken(event.payload.token_envelope,{idempotencyKey:event.idempotencyKey})};
}

const sqlOf=statement=>typeof statement==='string'?statement:String(statement?.sql||'');

// Wraps a real libSQL client so individual statements, commits, rollbacks and
// closes can be observed or replaced while all other SQL runs for real.
function instrumented(db,{intercept=()=>undefined,commit,rollback,close,transaction}={}){
  const calls={statements:[],rollbacks:0,closes:0,commits:0,transactions:0};
  return {calls,execute:statement=>db.execute(statement),
    transaction:async mode=>{
      calls.transactions+=1;
      if(transaction) await transaction(calls.transactions);
      const tx=await db.transaction(mode);
      return {
        async execute(statement){
          calls.statements.push(sqlOf(statement));
          const replaced=await intercept(sqlOf(statement),statement);
          return replaced===undefined?tx.execute(statement):replaced;
        },
        async commit(){ calls.commits+=1; if(commit) await commit(); return tx.commit(); },
        async rollback(){ calls.rollbacks+=1; await tx.rollback(); if(rollback) await rollback(); },
        close(){ calls.closes+=1; tx.close?.(); if(close) close(); },
      };
    }};
}

async function passwordHashOf(db){
  return String((await db.execute(`SELECT password_hash FROM auth_accounts WHERE id=1`)).rows[0].password_hash);
}

test('reset configuration is enabled only for a safe origin, provider, and valid key ring',()=>{
  baseEnv();
  assert.deepEqual({...passwordResetConfiguration()},{origin:'https://randori.example.test'});
  process.env.APP_URL='http://localhost:3000/';
  assert.equal(passwordResetConfiguration().origin,'http://localhost:3000');

  process.env.PASSWORD_RESET_ENABLED='false';
  assert.equal(passwordResetConfiguration(),null);
  process.env.PASSWORD_RESET_ENABLED='true';

  for(const appUrl of ['', 'not a url','https://user:pass@randori.example.test','https://randori.example.test/app',
    'https://randori.example.test/?next=1','https://randori.example.test/#x','ftp://randori.example.test']){
    process.env.APP_URL=appUrl;
    assert.equal(passwordResetConfiguration(),null,appUrl);
  }

  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  assert.equal(passwordResetConfiguration(),null,'production requires an email provider');
  process.env.RESEND_API_KEY='re_test';
  assert.equal(passwordResetConfiguration(),null,'production requires a sender');
  process.env.RESEND_FROM='  ';
  assert.equal(passwordResetConfiguration(),null,'blank sender is not configured');
  process.env.RESEND_FROM='Randori <noreply@example.test>';
  assert.equal(passwordResetConfiguration().origin,'https://randori.example.test');
  for(const appUrl of ['http://randori.example.test','https://localhost','https://127.0.0.1']){
    process.env.APP_URL=appUrl;
    assert.equal(passwordResetConfiguration(),null,`production rejects ${appUrl}`);
  }
  process.env.APP_URL='https://randori.example.test';
  delete process.env.PASSWORD_RESET_ENCRYPTION_KEY;
  assert.equal(passwordResetConfiguration(),null,'production has no JWT-derived fallback key');
  assert.throws(()=>passwordResetKeyRing(),{message:'PASSWORD_RESET_ENCRYPTION_KEY ring is invalid'});
});

test('development falls back to a JWT-derived envelope key while token helpers reject malformed input',()=>{
  baseEnv();
  delete process.env.PASSWORD_RESET_ENCRYPTION_KEY;
  process.env.PASSWORD_RESET_ENVELOPE_WRITE_VERSION='2';
  assert.ok(passwordResetConfiguration());
  const token='B'.repeat(43);
  const envelope=sealPasswordResetToken(token,{idempotencyKey:'password-reset/v1/x/1'});
  assert.equal(openPasswordResetToken(envelope,{idempotencyKey:'password-reset/v1/x/1'}),token);
  assert.equal(openPasswordResetToken(envelope,{idempotencyKey:'password-reset/v1/x/2'}),null,
    'envelope is bound to the outbox idempotency key');
  process.env.JWT_SECRET=`${JWT_SECRET}-rotated`;
  assert.equal(openPasswordResetToken(envelope,{idempotencyKey:'password-reset/v1/x/1'}),null,
    'derived key changes with the JWT secret');

  for(const bad of [null,42,'short','A'.repeat(44),`${'A'.repeat(42)}=`]) assert.equal(hashPasswordResetToken(bad),null);
  assert.throws(()=>sealPasswordResetToken('not-a-token'),TypeError);
  assert.equal(openPasswordResetToken('garbage'),null);
  assert.equal(openPasswordResetToken(undefined),null);
});

test('readiness validates inputs, probes every table, and enforces key control only when delivery is enabled',async()=>{
  await assert.rejects(()=>ensurePasswordResetReadiness(null),TypeError);
  await assert.rejects(()=>ensurePasswordResetReadiness({}),TypeError);
  await assert.rejects(()=>ensurePasswordResetReadiness({execute(){}},{requireDeliveryKey:'yes'}),
    /valid password reset readiness options required/);

  const unadopted=await fixture({adopt:false});
  await ensurePasswordResetReadiness(unadopted,{requireDeliveryKey:false});
  await assert.rejects(()=>ensurePasswordResetReadiness(unadopted,{requireDeliveryKey:true}),
    'an unadopted key ring fails closed');

  const db=await fixture();
  await ensurePasswordResetReadiness(db);
  process.env.NODE_ENV='production';
  delete process.env.PASSWORD_RESET_ENCRYPTION_KEY;
  await assert.rejects(()=>ensurePasswordResetReadiness(db,{requireDeliveryKey:true}),/ring is invalid/);
  await ensurePasswordResetReadiness(db,{requireDeliveryKey:false});

  baseEnv();
  const empty=await emptyDatabase();
  await assert.rejects(()=>ensurePasswordResetReadiness(empty,{requireDeliveryKey:false}),
    /no such table/);
});

test('request validates the client and clock, and rolls back on failure',async()=>{
  baseEnv();
  await assert.rejects(()=>requestPasswordReset(null,{email:'member@example.test'}),TypeError);
  await assert.rejects(()=>requestPasswordReset({execute(){}},{email:'member@example.test'}),TypeError);
  const db=await fixture();

  for(const nowSeconds of [0,-1,1.5,'1']){
    const wrapped=instrumented(db);
    await assert.rejects(()=>requestPasswordReset(wrapped,{email:'member@example.test'},{nowSeconds}),
      /valid password reset time is required/);
    assert.equal(wrapped.calls.rollbacks,1);
  }

  const badClock=instrumented(db,{intercept:sql=>sql.includes("strftime('%s','now')")?{rows:[{now_seconds:null}]}:undefined});
  await assert.rejects(()=>requestPasswordReset(badClock,{email:'member@example.test'}),/database password reset time unavailable/);
  assert.equal(badClock.calls.rollbacks,1);

  const failing=instrumented(db,{intercept:sql=>{ if(sql.includes('INSERT INTO outbox_events')) throw new Error('outbox down'); },
    rollback:()=>{ throw new Error('rollback also failed'); }});
  await assert.rejects(()=>requestPasswordReset(failing,{email:'member@example.test'},{nowSeconds:NOW}),/outbox down/,
    'the original error wins over a rollback failure');
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS n FROM auth_password_resets`)).rows[0].n),0,
    'reset row is not persisted without its outbox event');

  const dbClock=instrumented(db);
  assert.equal((await requestPasswordReset(dbClock,{email:'member@example.test'})).accepted,true,
    'database clock is used when no override is supplied');
});

test('malformed emails take the same transaction shape as eligible ones without touching identity data',async()=>{
  const db=await fixture();
  const eligible=instrumented(db);
  const malformed=instrumented(db);
  assert.equal((await requestPasswordReset(eligible,{email:'member@example.test'},{nowSeconds:NOW})).accepted,true);
  assert.deepEqual({...await requestPasswordReset(malformed,{email:'not an email'},{nowSeconds:NOW})},{accepted:false});
  assert.equal(malformed.calls.statements.length,eligible.calls.statements.length);
  assert.equal(malformed.calls.statements.some(sql=>sql.includes('auth_accounts')),false);
  assert.equal(malformed.calls.commits,1);
});

test('membership-gated reset requires an active primary circle membership',async()=>{
  const db=await fixture();
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  assert.equal((await requestPasswordReset(db,{email:'member@example.test'},{nowSeconds:NOW})).accepted,false);
  await db.batch([
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (10,'11111111-1111-4111-8111-111111111111','randori-circle','Randori Circle',1,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (10,1,'member','active',datetime('now'),datetime('now'))`,
  ],'write');
  assert.equal((await requestPasswordReset(db,{email:'Member@Example.test'},{nowSeconds:NOW})).accepted,true);

  const event=await latestEvent(db);
  const sent=[];
  const handler=createPasswordResetHandler({db,baseUrl:'https://randori.example.test/ignored',send:message=>{
    sent.push(message); return {data:{id:'resend-1'}};
  }});
  assert.deepEqual(await handler(event),{status:'delivered',providerName:'email',providerMessageId:'resend-1'});
  assert.match(sent[0].html,/https:\/\/randori\.example\.test\/reset-password#token=/);
  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE user_id=1`);
  assert.deepEqual(await handler(event),{status:'suppressed',reasonCode:'PASSWORD_RESET_INACTIVE'},
    'delivery re-checks membership at send time');
});

test('consume rejects malformed inputs and reports revoked, expired, and identity-changed resets',async()=>{
  baseEnv();
  await assert.rejects(()=>consumePasswordReset(null,{token:'A'.repeat(43),passwordHash:'$2b$'}),TypeError);
  const db=await fixture();
  const goodHash=await bcrypt.hash('new correct horse',4);
  for(const input of [{token:'bad',passwordHash:goodHash},{token:'A'.repeat(43),passwordHash:'plaintext'},
    {token:'A'.repeat(43),passwordHash:`$2${'x'.repeat(127)}`},{token:'A'.repeat(43),passwordHash:null}]){
    assert.deepEqual(await consumePasswordReset(db,input,{nowSeconds:NOW}),{status:'invalid'});
  }
  assert.deepEqual(await consumePasswordReset(db,{token:'A'.repeat(43),passwordHash:goodHash},{nowSeconds:NOW}),
    {status:'invalid'},'unknown token');

  const {token}=await requestedToken(db);
  await db.execute({sql:`UPDATE auth_password_resets SET revoked_at=?`,args:[NOW]});
  assert.deepEqual(await consumePasswordReset(db,{token,passwordHash:goodHash},{nowSeconds:NOW+1}),{status:'revoked'});
  await db.execute(`UPDATE auth_password_resets SET revoked_at=NULL`);
  assert.deepEqual(await consumePasswordReset(db,{token,passwordHash:goodHash},
    {nowSeconds:NOW+30*60}),{status:'expired'},'expiry boundary is exclusive');

  const original=await passwordHashOf(db);
  await db.execute(`UPDATE auth_accounts SET email='changed@example.test' WHERE id=1`);
  assert.deepEqual(await consumePasswordReset(db,{token,passwordHash:goodHash},{nowSeconds:NOW+1}),{status:'revoked'},
    'an email change after the request invalidates the reset');
  await db.execute(`UPDATE auth_accounts SET email='member@example.test',password_hash='!oauth:opaque' WHERE id=1`);
  assert.deepEqual(await consumePasswordReset(db,{token,passwordHash:goodHash},{nowSeconds:NOW+1}),{status:'revoked'},
    'an account converted to OAuth-only cannot be reset');
  await db.execute({sql:`UPDATE auth_accounts SET password_hash=? WHERE id=1`,args:[original]});
  assert.deepEqual(await consumePasswordReset(db,{token,passwordHash:goodHash}),{status:'reset'},
    'database clock path succeeds');
});

test('consume rolls back the password change when a guarded write loses its race',async()=>{
  const db=await fixture();
  const {token}=await requestedToken(db);
  const original=await passwordHashOf(db);
  const goodHash=await bcrypt.hash('new correct horse',4);

  const accountRace=instrumented(db,{intercept:sql=>sql.startsWith('UPDATE auth_accounts SET password_hash')?{rows:[]}:undefined,
    close:()=>{ throw new Error('close failed'); }});
  assert.deepEqual(await consumePasswordReset(accountRace,{token,passwordHash:goodHash},{nowSeconds:NOW+1}),{status:'revoked'});
  assert.equal(accountRace.calls.rollbacks,1);

  const consumeRace=instrumented(db,{intercept:sql=>sql.startsWith('UPDATE auth_password_resets SET used_at')?{rows:[]}:undefined});
  assert.deepEqual(await consumePasswordReset(consumeRace,{token,passwordHash:goodHash},{nowSeconds:NOW+1}),{status:'revoked'});
  assert.equal(await passwordHashOf(db),original,'password update is rolled back with the reset');
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NOT NULL`)).rows[0].n),0);

  const closeFails=instrumented(db,{close:()=>{ throw new Error('close failed'); }});
  assert.deepEqual(await consumePasswordReset(closeFails,{token,passwordHash:goodHash},{nowSeconds:NOW+1}),{status:'reset'},
    'a close failure after commit does not undo success');
});

test('consume retries only transient lock conflicts before commit',async()=>{
  const db=await fixture();
  const {token}=await requestedToken(db);
  const goodHash=await bcrypt.hash('new correct horse',4);
  const transient=[{code:'SQLITE_BUSY'},{rawCode:'libsql_transaction_busy'},
    {message:'SQLITE_LOCKED: database table is locked'},Object.assign(new Error('wrapper'),{cause:{code:'SQLITE_LOCKED'}})];
  const flaky=instrumented(db,{transaction:attempt=>{
    if(attempt<=4) throw Object.assign(new Error('busy'),transient[attempt-1]);
  }});
  await assert.rejects(()=>consumePasswordReset(flaky,{token,passwordHash:goodHash},{nowSeconds:NOW+1}),/busy/,
    'four consecutive conflicts exhaust the retry budget');

  const recovering=instrumented(db,{transaction:attempt=>{
    if(attempt<=3) throw Object.assign(new Error('wrapper'),{cause:transient[3].cause});
  }});
  assert.deepEqual(await consumePasswordReset(recovering,{token,passwordHash:goodHash},{nowSeconds:NOW+1}),{status:'reset'});
  assert.equal(recovering.calls.transactions,4);
});

test('consume does not retry non-transient errors or commit failures, and cleans up mid-transaction errors',async()=>{
  const db=await fixture();
  const {token}=await requestedToken(db);
  const goodHash=await bcrypt.hash('new correct horse',4);

  const hard=instrumented(db,{intercept:sql=>{ if(sql.startsWith('SELECT reset.*')) throw new Error('disk I/O error'); },
    rollback:()=>{ throw new Error('rollback failed'); },close:()=>{ throw new Error('close failed'); }});
  await assert.rejects(()=>consumePasswordReset(hard,{token,passwordHash:goodHash},{nowSeconds:NOW+1}),/disk I\/O error/);
  assert.equal(hard.calls.transactions,1);
  assert.equal(hard.calls.rollbacks,1);
  assert.equal(hard.calls.closes,1);

  const commitBusy=instrumented(db,{commit:()=>{ throw Object.assign(new Error('busy at commit'),{code:'SQLITE_BUSY'}); }});
  await assert.rejects(()=>consumePasswordReset(commitBusy,{token,passwordHash:goodHash},{nowSeconds:NOW+1}),/busy at commit/);
  assert.equal(commitBusy.calls.transactions,1,'an ambiguous commit is never retried');
  assert.equal(commitBusy.calls.rollbacks,0);
});

test('delivery handler validates construction and event metadata',async()=>{
  const db=await fixture();
  const send=()=>({});
  assert.throws(()=>createPasswordResetHandler({}),TypeError);
  assert.throws(()=>createPasswordResetHandler({db,send:'no'}),TypeError);
  assert.throws(()=>createPasswordResetHandler({db,send,baseUrl:'not a url'}),/valid password reset base URL required/);
  const handler=createPasswordResetHandler({db,send,baseUrl:'https://randori.example.test'});
  process.env.PASSWORD_RESET_ENVELOPE_WRITE_VERSION='2';
  const {event}=await requestedToken(db);
  const expectCode=async(mutated,code,retryable)=>{
    await assert.rejects(()=>handler(mutated),error=>error instanceof OutboxDeliveryError
      &&error.code===code&&error.retryable===retryable);
  };
  await expectCode({...event,eventVersion:2},'EVENT_VERSION_UNSUPPORTED',true);
  await expectCode({...event,eventVersion:0},'EVENT_VERSION_UNSUPPORTED',false);
  await expectCode({...event,payload:null},'PAYLOAD_INVALID',false);
  await expectCode({...event,payload:{...event.payload,extra:1}},'PAYLOAD_INVALID',false);
  await expectCode({...event,payload:{...event.payload,reset_id:'not-a-uuid'}},'PAYLOAD_INVALID',false);
  await expectCode({...event,payload:{...event.payload,reset_id:null}},'PAYLOAD_INVALID',false);
  await expectCode({...event,payload:{...event.payload,recipient_email:'nope'}},'PAYLOAD_INVALID',false);
  await expectCode({...event,payload:{...event.payload,token_envelope:42}},'PAYLOAD_INVALID',false);
  await expectCode({...event,payload:{...event.payload,token_envelope:'x'.repeat(8193)}},'PAYLOAD_INVALID',false);
  await expectCode({...event,idempotencyKey:'password-reset/v1/other/1'},'ENVELOPE_INVALID',false);
  await expectCode({...event,idempotencyKey:'not a valid key'},'ENVELOPE_CONTEXT_INVALID',false);
  await expectCode({...event,payload:{...event.payload,token_envelope:'v3.a.b'}},'ENVELOPE_VERSION_UNAVAILABLE',true);
  const otherToken='C'.repeat(43);
  await expectCode({...event,payload:{...event.payload,
    token_envelope:sealPasswordResetToken(otherToken,{idempotencyKey:event.idempotencyKey})}},'PAYLOAD_INVALID',false);
  await expectCode({...event,payload:{...event.payload,token_envelope:'%%%'}},'ENVELOPE_INVALID',false);
});

test('provider failures map to retryable and terminal outbox errors',async()=>{
  const db=await fixture();
  const {event}=await requestedToken(db);
  const outcome=async send=>{
    try{ return await createPasswordResetHandler({db,send,baseUrl:'https://randori.example.test'})(event); }
    catch(error){ return {code:error.code,retryable:error.retryable,cause:error.cause}; }
  };
  assert.deepEqual(await outcome(()=>({providerName:'p'.repeat(150),providerMessageId:'m-1'})),
    {status:'delivered',providerName:'p'.repeat(100),providerMessageId:'m-1'});
  assert.deepEqual(await outcome(()=>undefined),{status:'delivered',providerName:'email',providerMessageId:null});
  assert.equal((await outcome(()=>({error:{statusCode:429}}))).code,'PROVIDER_RATE_LIMITED');
  assert.equal((await outcome(()=>{ throw {response:{status:429}}; })).retryable,true);
  assert.deepEqual(await outcome(()=>({error:{status:422}})).then(({code,retryable})=>({code,retryable})),
    {code:'PROVIDER_REJECTED',retryable:false});
  assert.equal((await outcome(()=>{ throw {error:{statusCode:400}}; })).code,'PROVIDER_REJECTED');
  assert.deepEqual(await outcome(()=>{ throw new Error('socket hang up'); }).then(({code,retryable})=>({code,retryable})),
    {code:'PROVIDER_FAILED',retryable:true});
  assert.equal((await outcome(()=>({error:{statusCode:503}}))).code,'PROVIDER_FAILED');
  assert.deepEqual(await outcome(()=>{ throw new OutboxDeliveryError('CUSTOM_CODE',{retryable:false}); })
    .then(({code,retryable})=>({code,retryable})),{code:'CUSTOM_CODE',retryable:false},'outbox errors pass through');
});

test('status counts reset events by outbox state',async()=>{
  const db=await fixture();
  assert.deepEqual(await passwordResetStatus(db),{pending:0,processing:0,retry:0,delivered:0,suppressed:0,dead_letter:0});
  await requestedToken(db);
  assert.equal((await passwordResetStatus(db)).pending,1);
  const result=await deliverPasswordResets({db,baseUrl:'https://randori.example.test',workerId:'cov-p1-reset',
    send:()=>({providerName:'test'}),workerOptions:{heartbeatIntervalMs:0}});
  assert.equal(result.delivered,1);
  assert.deepEqual(await passwordResetStatus(db),{pending:0,processing:0,retry:0,delivered:1,suppressed:0,dead_letter:0});
});
