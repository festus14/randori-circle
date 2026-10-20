import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,test} from 'node:test';

import {createClient} from '@libsql/client';
import bcrypt from 'bcryptjs';

import {
  activationKeyRing,
  createEmailActivationHandler,
  deliverEmailActivations,
  emailActivationConfiguration,
  emailActivationStatus,
  ensureEmailActivationReadiness,
  hashEmailActivationToken,
  openEmailActivationToken,
  requestEmailActivation,
  resendEmailActivation,
  sealEmailActivationToken,
  verifyEmailActivation,
} from '../../api/_email-activation.js';
import {createInvitationToken,hashInvitationEmail,hashInvitationToken} from '../../api/_circle-membership.js';
import {OutboxDeliveryError} from '../../api/_outbox.js';
import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';
import {adoptCredentialKeyControl} from '../support/credential-key-control.mjs';

const JWT_SECRET='cov-p1-email-activation-secret-at-least-thirty-two-bytes';
const ENCRYPTION_KEY=Buffer.alloc(32,29).toString('base64url');
const NOW=Math.floor(Date.now()/1000);
const ENV_KEYS=['JWT_SECRET','EMAIL_VERIFICATION_ENCRYPTION_KEY','EMAIL_PASSWORD_ACTIVATION_ENABLED',
  'CIRCLE_MEMBERSHIP_ENABLED','APP_URL','NODE_ENV','RESEND_API_KEY','RESEND_FROM',
  'EMAIL_VERIFICATION_ENVELOPE_WRITE_VERSION'];
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
  process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY=ENCRYPTION_KEY;
  process.env.EMAIL_PASSWORD_ACTIVATION_ENABLED='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.APP_URL='https://randori.example.test';
  delete process.env.NODE_ENV;
}

async function emptyDatabase(){
  const directory=mkdtempSync(join(tmpdir(),'randori-cov-p1-activation-'));
  const db=createClient({url:`file:${join(directory,'activation.sqlite')}`});
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
  if(adopt) await adoptCredentialKeyControl(db,activationKeyRing());
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin)
      VALUES (1,'owner@example.test','!owner','Owner','#111111',1)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (10,'11111111-1111-4111-8111-111111111111','randori-circle','Randori Circle',1,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (10,1,'owner','active',datetime('now'),datetime('now'))`,
  ],'write');
  return db;
}

async function invite(db,email='member@example.test',{id='22222222-2222-4222-8222-222222222222'}={}){
  const tokenHash=hashInvitationToken(createInvitationToken());
  const emailHash=hashInvitationEmail(email);
  await db.execute({sql:`INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
    VALUES (?,10,?,?,1,datetime('now'),datetime('now','+1 day'))`,args:[id,tokenHash,emailHash]});
  return {invitation_id:id,circle_id:10,token_hash:tokenHash,email_hash:emailHash};
}

const PASSWORD_HASH=await bcrypt.hash('correct horse battery',4);
const registration=(claim,overrides={})=>({claim,email:'member@example.test',passwordHash:PASSWORD_HASH,
  displayName:'Invited Member',color:'#123456',...overrides});

async function latestEvent(db){
  const row=(await db.execute(`SELECT id,event_type,event_version,idempotency_key,payload_json FROM outbox_events
    WHERE event_type='auth.emailverification.requested' ORDER BY id DESC LIMIT 1`)).rows[0];
  return {id:Number(row.id),eventType:String(row.event_type),eventVersion:Number(row.event_version),
    idempotencyKey:String(row.idempotency_key),payload:JSON.parse(String(row.payload_json))};
}

async function pendingActivation(db,{email='member@example.test',id}={}){
  const claim=await invite(db,email,id?{id}:undefined);
  assert.equal((await requestEmailActivation(db,registration(claim,{email}),{nowSeconds:NOW})).accepted,true);
  const event=await latestEvent(db);
  return {claim,event,token:openEmailActivationToken(event.payload.token_envelope,{idempotencyKey:event.idempotencyKey})};
}

const sqlOf=statement=>typeof statement==='string'?statement:String(statement?.sql||'');

function instrumented(db,{intercept=()=>undefined,rollback}={}){
  const calls={statements:[],rollbacks:0,commits:0};
  return {calls,execute:statement=>db.execute(statement),
    transaction:async mode=>{
      const tx=await db.transaction(mode);
      return {
        async execute(statement){
          calls.statements.push(sqlOf(statement));
          const replaced=await intercept(sqlOf(statement));
          return replaced===undefined?tx.execute(statement):replaced;
        },
        async commit(){ calls.commits+=1; return tx.commit(); },
        async rollback(){ calls.rollbacks+=1; await tx.rollback(); if(rollback) await rollback(); },
        close(){ tx.close?.(); },
      };
    }};
}

const count=async(db,sql)=>Number((await db.execute(sql)).rows[0].n);

test('activation configuration requires both flags, a safe origin, provider settings, and a key ring',()=>{
  baseEnv();
  assert.equal(emailActivationConfiguration().origin,'https://randori.example.test');
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  assert.equal(emailActivationConfiguration(),null,'activation depends on circle membership');
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.EMAIL_PASSWORD_ACTIVATION_ENABLED='false';
  assert.equal(emailActivationConfiguration(),null);
  process.env.EMAIL_PASSWORD_ACTIVATION_ENABLED='true';
  for(const appUrl of ['::bad::','https://a:b@randori.example.test','https://randori.example.test/sub',
    'https://randori.example.test/?a=1','https://randori.example.test/#f','ws://randori.example.test']){
    process.env.APP_URL=appUrl;
    assert.equal(emailActivationConfiguration(),null,appUrl);
  }
  process.env.APP_URL='http://[::1]:8080';
  assert.equal(emailActivationConfiguration().origin,'http://[::1]:8080','loopback allowed outside production');

  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  assert.equal(emailActivationConfiguration(),null);
  process.env.RESEND_API_KEY='re_test';
  process.env.RESEND_FROM='Randori <noreply@example.test>';
  assert.equal(emailActivationConfiguration().origin,'https://randori.example.test');
  for(const appUrl of ['http://randori.example.test','https://localhost']){
    process.env.APP_URL=appUrl;
    assert.equal(emailActivationConfiguration(),null,appUrl);
  }
  process.env.APP_URL='https://randori.example.test';
  delete process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY;
  assert.equal(emailActivationConfiguration(),null);
  assert.throws(()=>activationKeyRing(),{message:'EMAIL_VERIFICATION_ENCRYPTION_KEY ring is invalid'});
});

test('development derives an envelope key from the JWT secret and v2 envelopes are context bound',()=>{
  baseEnv();
  delete process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY;
  process.env.EMAIL_VERIFICATION_ENVELOPE_WRITE_VERSION='2';
  const token='D'.repeat(43);
  const envelope=sealEmailActivationToken(token,{idempotencyKey:'auth-activation/v1/a/1'});
  assert.match(envelope,/^v2\./);
  assert.equal(openEmailActivationToken(envelope,{idempotencyKey:'auth-activation/v1/a/1'}),token);
  assert.equal(openEmailActivationToken(envelope,{idempotencyKey:'auth-activation/v1/a/2'}),null);
  for(const bad of [undefined,{},'x','E'.repeat(42)]) assert.equal(hashEmailActivationToken(bad),null);
  assert.throws(()=>sealEmailActivationToken('short'),/invalid email activation token/);
  assert.equal(openEmailActivationToken('a.b.c'),null);
});

test('readiness rejects missing clients and unadopted key control, and probes the schema',async()=>{
  await assert.rejects(()=>ensureEmailActivationReadiness(null),TypeError);
  const unadopted=await fixture({adopt:false});
  await assert.rejects(()=>ensureEmailActivationReadiness(unadopted));
  const db=await fixture();
  await ensureEmailActivationReadiness(db);
  const empty=await emptyDatabase();
  await assert.rejects(()=>ensureEmailActivationReadiness(empty),/no such table/);
});

test('malformed registrations are refused with the same statement shape and no identity lookups',async()=>{
  const db=await fixture();
  const claim=await invite(db);
  const invalidInputs=[
    null,
    registration(null),
    registration([]),
    registration({...claim,invitation_id:'not-a-uuid'}),
    registration({...claim,invitation_id:undefined}),
    registration({...claim,circle_id:0}),
    registration({...claim,circle_id:'1.5'}),
    registration({...claim,token_hash:'ABC'}),
    registration({...claim,token_hash:undefined}),
    registration({...claim,email_hash:'f'.repeat(63)}),
    registration({...claim,email_hash:undefined}),
    registration(claim,{email:'not-an-email'}),
    registration(claim,{email:'someone-else@example.test'}),
    registration(claim,{passwordHash:'plain'}),
    registration(claim,{passwordHash:`$2${'a'.repeat(127)}`}),
    registration(claim,{passwordHash:42}),
    registration(claim,{displayName:' A '}),
    registration(claim,{displayName:null}),
    registration(claim,{color:null}),
    registration(claim,{color:'#'.repeat(33)}),
  ];
  const refusedShapes=new Set();
  for(const input of invalidInputs){
    const wrapped=instrumented(db);
    assert.deepEqual({...await requestEmailActivation(wrapped,input,{nowSeconds:NOW})},{accepted:false});
    assert.equal(wrapped.calls.statements.some(sql=>/auth_accounts|circle_invitations/.test(sql)),false);
    assert.equal(wrapped.calls.commits,1);
    refusedShapes.add(wrapped.calls.statements.length);
  }
  assert.equal(refusedShapes.size,1);
  const eligible=instrumented(db);
  assert.equal((await requestEmailActivation(eligible,registration(claim,{displayName:`  ${'N'.repeat(40)}  `}),
    {nowSeconds:NOW})).accepted,true);
  assert.equal(eligible.calls.statements.length,[...refusedShapes][0],'statement count matches the refused path');
  assert.equal(String((await db.execute(`SELECT display_name FROM auth_email_activations`)).rows[0].display_name),
    'N'.repeat(32),'display names are trimmed and bounded');
  assert.equal(await count(db,`SELECT COUNT(*) AS n FROM auth_email_activations`),1);
});

test('request and resend validate clients and clocks, and roll back on failure',async()=>{
  baseEnv();
  await assert.rejects(()=>requestEmailActivation(null,{}),TypeError);
  await assert.rejects(()=>resendEmailActivation({},{claim:null,email:''}),TypeError);
  const db=await fixture();
  const claim=await invite(db);

  for(const nowSeconds of [0,2.5]){
    const wrapped=instrumented(db);
    await assert.rejects(()=>requestEmailActivation(wrapped,registration(claim),{nowSeconds}),
      /valid activation time is required/);
    assert.equal(wrapped.calls.rollbacks,1);
  }
  const badClock=instrumented(db,{intercept:sql=>sql.includes("strftime('%s','now') AS INTEGER) AS now_seconds")
    ?{rows:[]}:undefined});
  await assert.rejects(()=>requestEmailActivation(badClock,registration(claim)),/database activation time unavailable/);

  const outboxDown=instrumented(db,{intercept:sql=>{ if(sql.includes('INSERT INTO outbox_events')) throw new Error('outbox down'); },
    rollback:()=>{ throw new Error('rollback failed'); }});
  await assert.rejects(()=>requestEmailActivation(outboxDown,registration(claim),{nowSeconds:NOW}),/outbox down/);
  assert.equal(await count(db,`SELECT COUNT(*) AS n FROM auth_email_activations`),0,
    'activation row is rolled back with its event');

  assert.equal((await requestEmailActivation(db,registration(claim))).accepted,true,'database clock path');
  const resendDown=instrumented(db,{intercept:sql=>{ if(sql.includes('INSERT INTO outbox_events')) throw new Error('outbox down'); }});
  await assert.rejects(()=>resendEmailActivation(resendDown,{claim,email:'member@example.test'},{nowSeconds:NOW+3_600}),/outbox down/);
  assert.equal(resendDown.calls.rollbacks,1);
  assert.equal(await count(db,`SELECT send_count AS n FROM auth_email_activations`),1,'failed resend does not consume a send');
});

test('resend refuses malformed or mismatched claims before opening a transaction',async()=>{
  const db=await fixture();
  const {claim}=await pendingActivation(db);
  for(const input of [{claim:null,email:'member@example.test'},{claim,email:'bad'},
    {claim,email:'other@example.test'},{claim:{...claim,circle_id:-1},email:'member@example.test'}]){
    const wrapped=instrumented(db);
    assert.deepEqual(await resendEmailActivation(wrapped,input,{nowSeconds:NOW+3_600}),{accepted:false});
    assert.equal(wrapped.calls.statements.length,0);
  }
});

test('verification fails closed on malformed tokens, revoked state, and expired invitations',async()=>{
  baseEnv();
  await assert.rejects(()=>verifyEmailActivation(null,{token:'A'.repeat(43)}),TypeError);
  const db=await fixture();
  assert.deepEqual(await verifyEmailActivation(db,{token:'nope'}),{status:'invalid'});
  const {claim,token}=await pendingActivation(db);
  const verifyAt=async()=>(await verifyEmailActivation(db,{token},{nowSeconds:NOW+10})).status;

  await db.execute(`UPDATE auth_email_activations SET revoked_at=created_at`);
  assert.equal(await verifyAt(),'revoked');
  await db.execute(`UPDATE auth_email_activations SET revoked_at=NULL`);
  await db.execute({sql:`UPDATE circle_invitations SET used_at=datetime('now') WHERE id=?`,args:[claim.invitation_id]});
  assert.equal(await verifyAt(),'revoked','an invitation consumed elsewhere revokes the activation');
  await db.execute({sql:`UPDATE circle_invitations SET used_at=NULL WHERE id=?`,args:[claim.invitation_id]});
  await db.execute(`UPDATE circles SET archived_at=datetime('now') WHERE id=10`);
  assert.equal(await verifyAt(),'revoked','an archived circle revokes the activation');
  await db.execute(`UPDATE circles SET archived_at=NULL WHERE id=10`);
  await db.execute({sql:`UPDATE circle_invitations SET expires_at=? WHERE id=?`,
    args:[new Date((NOW+5)*1000).toISOString(),claim.invitation_id]});
  assert.equal(await verifyAt(),'expired','invitation expiry is enforced independently of the activation TTL');
  await db.execute({sql:`UPDATE circle_invitations SET expires_at=datetime('now','+1 day') WHERE id=?`,args:[claim.invitation_id]});

  await db.execute(`UPDATE auth_email_activations SET email='tampered@example.test'`);
  assert.equal(await verifyAt(),'invalid','stored email must still match its hash');
  await db.execute(`UPDATE auth_email_activations SET email='member@example.test'`);

  await db.execute({sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES (5,?,?,?,?)`,
    args:['member@example.test','!oauth','Racer','#000000']});
  assert.equal(await verifyAt(),'revoked','an account created meanwhile wins and no duplicate is made');
  assert.equal(await count(db,`SELECT COUNT(*) AS n FROM auth_accounts WHERE email='member@example.test'`),1);
  await db.execute(`DELETE FROM auth_accounts WHERE id=5`);
  const verified=await verifyEmailActivation(db,{token});
  assert.equal(verified.status,'verified','database clock path');
  assert.deepEqual({...verified.user,id:undefined},{id:undefined,email:'member@example.test',name:'Invited Member',
    color:'#123456',is_admin:false,isAdmin:false});
});

test('verification rolls the new account back when any guarded follow-up write loses its race',async()=>{
  const guarded=[
    ['UPDATE circle_invitations SET used_at',{rows:[]}],
    ['UPDATE circle_invitations SET used_at',{rows:[{circle_id:10,used_by:999}]}],
    ['INSERT INTO circle_memberships',{rows:[]}],
    ['INSERT INTO circle_memberships',{rows:[{circle_id:10,user_id:2,status:'inactive'}]}],
    ['INSERT INTO circle_audit_events',{rows:[]}],
    ['UPDATE auth_email_activations SET used_at',{rows:[]}],
  ];
  const db=await fixture();
  const {token}=await pendingActivation(db);
  for(const [prefix,result] of guarded){
    const wrapped=instrumented(db,{intercept:sql=>sql.trimStart().startsWith(prefix)?result:undefined});
    assert.deepEqual(await verifyEmailActivation(wrapped,{token},{nowSeconds:NOW+10}),{status:'revoked'},prefix);
    assert.equal(wrapped.calls.rollbacks,1);
    assert.equal(await count(db,`SELECT COUNT(*) AS n FROM auth_accounts WHERE email='member@example.test'`),0,prefix);
  }
  const failing=instrumented(db,{intercept:sql=>{ if(sql.startsWith('SELECT activation.*')) throw new Error('read failed'); },
    rollback:()=>{ throw new Error('rollback failed'); }});
  await assert.rejects(()=>verifyEmailActivation(failing,{token},{nowSeconds:NOW+10}),/read failed/);
  assert.equal((await verifyEmailActivation(db,{token},{nowSeconds:NOW+10})).status,'verified');
});

test('delivery handler validates construction, metadata, send sequence, and envelope binding',async()=>{
  const db=await fixture();
  const send=()=>({});
  assert.throws(()=>createEmailActivationHandler({}),TypeError);
  assert.throws(()=>createEmailActivationHandler({db}),TypeError);
  assert.throws(()=>createEmailActivationHandler({db,send,baseUrl:'::'}),/valid activation base URL required/);
  const handler=createEmailActivationHandler({db,send,baseUrl:'https://randori.example.test'});
  process.env.EMAIL_VERIFICATION_ENVELOPE_WRITE_VERSION='2';
  const {event}=await pendingActivation(db);
  const id=event.payload.activation_id;
  const expectCode=async(mutated,code,retryable)=>{
    await assert.rejects(()=>handler(mutated),error=>error instanceof OutboxDeliveryError
      &&error.code===code&&error.retryable===retryable,code);
  };
  await expectCode({...event,eventVersion:3},'EVENT_VERSION_UNSUPPORTED',true);
  await expectCode({...event,eventVersion:0},'EVENT_VERSION_UNSUPPORTED',false);
  await expectCode({...event,payload:undefined},'PAYLOAD_INVALID',false);
  await expectCode({...event,payload:{...event.payload,surprise:true}},'PAYLOAD_INVALID',false);
  await expectCode({...event,payload:{...event.payload,activation_id:null}},'PAYLOAD_INVALID',false);
  await expectCode({...event,payload:{...event.payload,recipient_email:42}},'PAYLOAD_INVALID',false);
  await expectCode({...event,payload:{...event.payload,token_envelope:null}},'PAYLOAD_INVALID',false);
  await expectCode({...event,payload:{...event.payload,token_envelope:'y'.repeat(8193)}},'PAYLOAD_INVALID',false);
  await expectCode({...event,idempotencyKey:null},'PAYLOAD_INVALID',false);
  await expectCode({...event,idempotencyKey:`auth-activation/v1/${id}/0`},'PAYLOAD_INVALID',false);
  await expectCode({...event,idempotencyKey:`auth-activation/v1/${id}/6`},'PAYLOAD_INVALID',false,
    'sequence beyond the send budget is rejected');
  assert.deepEqual(await handler({...event,idempotencyKey:`auth-activation/v1/${id}/2`}),
    {status:'suppressed',reasonCode:'ACTIVATION_INACTIVE'},'a stale send sequence is suppressed');
  await expectCode({...event,payload:{...event.payload,
    token_envelope:sealEmailActivationToken('F'.repeat(43),{idempotencyKey:event.idempotencyKey})}},'PAYLOAD_INVALID',false);
  await expectCode({...event,payload:{...event.payload,token_envelope:'v9.x'}},'ENVELOPE_VERSION_UNAVAILABLE',true);
  await expectCode({...event,payload:{...event.payload,token_envelope:'malformed'}},'ENVELOPE_INVALID',false);
});

test('activation provider outcomes map to delivered, retryable, and terminal states',async()=>{
  const db=await fixture();
  const {event}=await pendingActivation(db);
  const outcome=async send=>{
    try{ return await createEmailActivationHandler({db,send,baseUrl:'https://randori.example.test'})(event); }
    catch(error){ return {code:error.code,retryable:error.retryable}; }
  };
  assert.deepEqual(await outcome(()=>({data:{id:'resend-9'}})),{status:'delivered',providerName:'email',providerMessageId:'resend-9'});
  assert.deepEqual(await outcome(()=>({providerName:'x',providerMessageId:'m'})),{status:'delivered',providerName:'x',providerMessageId:'m'});
  assert.deepEqual(await outcome(()=>null),{status:'delivered',providerName:'email',providerMessageId:null});
  assert.deepEqual(await outcome(()=>({error:{statusCode:429}})),{code:'PROVIDER_RATE_LIMITED',retryable:true});
  assert.deepEqual(await outcome(()=>({error:{response:{status:403}}})),{code:'PROVIDER_REJECTED',retryable:false});
  assert.deepEqual(await outcome(()=>{ throw {error:{statusCode:500}}; }),{code:'PROVIDER_FAILED',retryable:true});
  assert.deepEqual(await outcome(()=>{ throw new Error('timeout'); }),{code:'PROVIDER_FAILED',retryable:true});
  assert.deepEqual(await outcome(()=>{ throw new OutboxDeliveryError('ABORTED',{retryable:false}); }),
    {code:'ABORTED',retryable:false});
  const reason=async send=>{
    try{ await createEmailActivationHandler({db,send,baseUrl:'https://randori.example.test'})(event); }
    catch(error){ return error.providerReason; }
  };
  assert.equal(await reason(()=>({error:{statusCode:403,name:'validation_error',message:'You can only send testing emails to your own email address (owner@example.test). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain.'}})),'403:validation_error:testing_recipient_restricted');
  assert.equal(await reason(()=>({error:{statusCode:429,name:'rate_limit_exceeded',message:'Too many requests'}})),
    '429:rate_limit_exceeded:rate_limited');
  assert.equal(await reason(()=>{ throw {statusCode:500,name:'internal_server_error'}; }),'500:internal_server_error:other');
  assert.equal(await reason(()=>{ throw new Error('timeout'); }),null);
});

test('activation status counts outbox events by delivery state',async()=>{
  const db=await fixture();
  assert.deepEqual(await emailActivationStatus(db),{pending:0,processing:0,retry:0,delivered:0,suppressed:0,dead_letter:0});
  await pendingActivation(db);
  await pendingActivation(db,{email:'second@example.test',id:'33333333-3333-4333-8333-333333333333'});
  assert.equal((await emailActivationStatus(db)).pending,2);
  await db.execute(`UPDATE auth_email_activations SET revoked_at=created_at WHERE email='second@example.test'`);
  const result=await deliverEmailActivations({db,baseUrl:'https://randori.example.test',workerId:'cov-p1-activation',
    send:()=>({providerName:'test'}),workerOptions:{heartbeatIntervalMs:0}});
  assert.equal(result.delivered,1);
  assert.deepEqual(await emailActivationStatus(db),{pending:0,processing:0,retry:0,delivered:1,suppressed:1,dead_letter:0});
});
