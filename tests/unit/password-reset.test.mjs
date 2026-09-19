import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,test} from 'node:test';

import {createClient} from '@libsql/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import {
  consumePasswordReset,
  createPasswordResetHandler,
  deliverPasswordResets,
  hashPasswordResetToken,
  openPasswordResetToken,
  PASSWORD_RESET_RESEND_SECONDS,
  passwordResetKeyRing,
  requestPasswordReset,
  sealPasswordResetToken,
} from '../../api/_password-reset.js';
import {issueSession,verifyRequestAuth} from '../../api/_db.js';
import {readRecentAuth,recordRecentAuth,requireRecentAuth} from '../../api/_recent-auth.js';
import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';
import {adoptCredentialKeyControl} from '../support/credential-key-control.mjs';

const JWT_SECRET='password-reset-test-secret-at-least-thirty-two-bytes';
const ENCRYPTION_KEY=Buffer.alloc(32,11).toString('base64url');
const NOW=Math.floor(Date.now()/1000);
const resources=[];

afterEach(()=>{
  for(const key of ['JWT_SECRET','PASSWORD_RESET_ENCRYPTION_KEY','PASSWORD_RESET_ENABLED',
    'CIRCLE_MEMBERSHIP_ENABLED','APP_URL','NODE_ENV','RESEND_API_KEY','RESEND_FROM']) delete process.env[key];
  while(resources.length){ try{ resources.pop()(); }catch{} }
});

async function fixture({clients=1}={}){
  process.env.JWT_SECRET=JWT_SECRET;
  process.env.PASSWORD_RESET_ENCRYPTION_KEY=ENCRYPTION_KEY;
  process.env.PASSWORD_RESET_ENABLED='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  process.env.APP_URL='https://randori.example.test';
  const directory=mkdtempSync(join(tmpdir(),'randori-password-reset-'));
  const url=`file:${join(directory,'reset.sqlite')}`;
  const databases=Array.from({length:clients},()=>createClient({url}));
  for(const db of databases) await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(databases[0]);
  await applyMigrations(databases[0],{expectedStateFingerprint:initial.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  await adoptCredentialKeyControl(databases[0],passwordResetKeyRing());
  const passwordHash=await bcrypt.hash('old correct horse',4);
  await databases[0].execute({sql:`INSERT INTO auth_accounts
    (id,email,password_hash,display_name,color,is_admin) VALUES (1,?,?,?,?,0)`,
  args:['member@example.test',passwordHash,'Member','#123456']});
  resources.push(()=>{
    for(const db of databases) db.close();
    rmSync(directory,{recursive:true,force:true});
  });
  return {db:databases[0],databases,url,passwordHash};
}

async function queuedToken(db){
  const row=(await db.execute(`SELECT payload_json FROM outbox_events
    WHERE event_type='auth.passwordreset.requested' ORDER BY id DESC LIMIT 1`)).rows[0];
  const payload=JSON.parse(String(row.payload_json));
  return {payload,token:openPasswordResetToken(payload.token_envelope)};
}

function countTransactionStatements(db,counter){
  return {transaction:async mode=>{
    const transaction=await db.transaction(mode);
    return {
      execute(statement){ counter.count+=1; return transaction.execute(statement); },
      commit:()=>transaction.commit(),rollback:()=>transaction.rollback(),close:()=>transaction.close?.(),
    };
  }};
}

test('reset stores only hashes, delivers a fragment link, changes the password, and revokes sessions atomically',async()=>{
  const {db}=await fixture();
  const oldSession=await issueSession(db,{id:1,email:'member@example.test',name:'Member'},
    {nowSeconds:NOW-100,recentAuthMethod:'password'});
  assert.deepEqual(await requestPasswordReset(db,{email:'member@example.test'},{nowSeconds:NOW}),{accepted:true});
  const {payload,token}=await queuedToken(db);
  assert.match(token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify((await db.execute(`SELECT * FROM auth_password_resets`)).rows).includes(token),false);
  assert.equal(payload.token_envelope.includes(token),false);
  assert.equal((await db.execute(`SELECT token_hash FROM auth_password_resets`)).rows[0].token_hash,
    hashPasswordResetToken(token));

  const messages=[];
  const delivery=await deliverPasswordResets({db,baseUrl:'https://randori.example.test',
    workerId:'password-reset-test',send:message=>{
      messages.push(message); return {providerName:'test',providerMessageId:'reset-1'};
    },workerOptions:{heartbeatIntervalMs:0}});
  assert.equal(delivery.delivered,1);
  assert.equal(messages.length,1);
  assert.match(messages[0].html,new RegExp(`/reset-password#token=${token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));

  const newHash=await bcrypt.hash('new correct horse',4);
  assert.deepEqual(await consumePasswordReset(db,{token,passwordHash:newHash},{nowSeconds:NOW+100}),{status:'reset'});
  assert.equal(await bcrypt.compare('new correct horse',String((await db.execute(`SELECT password_hash FROM auth_accounts WHERE id=1`)).rows[0].password_hash)),true);
  assert.equal(await verifyRequestAuth({headers:{cookie:`randori_session=${encodeURIComponent(oldSession)}`}},db,{nowSeconds:NOW+101}),null);
  assert.equal((await db.execute(`SELECT revocation_reason FROM auth_sessions WHERE user_id=1`)).rows[0].revocation_reason,'password_change');
  assert.deepEqual(await consumePasswordReset(db,{token,passwordHash:newHash},{nowSeconds:NOW+101}),{status:'used'});
});

test('unknown and ineligible emails are equivalent and OAuth-only identities get no reset',async()=>{
  const {db}=await fixture();
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color)
    VALUES (2,'oauth@example.test','!oauth:opaque','OAuth','#654321')`);
  const knownCounter={count:0};
  const unknownCounter={count:0};
  const oauthCounter={count:0};
  assert.deepEqual(await requestPasswordReset(countTransactionStatements(db,knownCounter),
    {email:'member@example.test'},{nowSeconds:NOW}),{accepted:true});
  assert.deepEqual(await requestPasswordReset(countTransactionStatements(db,unknownCounter),
    {email:'unknown@example.test'},{nowSeconds:NOW}),{accepted:false});
  assert.deepEqual(await requestPasswordReset(countTransactionStatements(db,oauthCounter),
    {email:'oauth@example.test'},{nowSeconds:NOW}),{accepted:false});
  assert.deepEqual([knownCounter.count,unknownCounter.count,oauthCounter.count],[3,3,3]);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_password_resets`)).rows[0].count),1);
});

test('resends rotate tokens, enforce cooldown and lifetime bounds, and suppress stale queued mail',async()=>{
  const {db}=await fixture();
  await requestPasswordReset(db,{email:'member@example.test'},{nowSeconds:NOW});
  const first=(await queuedToken(db)).token;
  assert.deepEqual(await requestPasswordReset(db,{email:'member@example.test'},{nowSeconds:NOW+1}),{accepted:false});
  for(let send=2;send<=5;send+=1){
    assert.deepEqual(await requestPasswordReset(db,{email:'member@example.test'},
      {nowSeconds:NOW+(send-1)*PASSWORD_RESET_RESEND_SECONDS}),{accepted:true});
  }
  assert.deepEqual(await requestPasswordReset(db,{email:'member@example.test'},{nowSeconds:NOW+1_000}),{accepted:false});
  const latest=(await queuedToken(db)).token;
  assert.notEqual(first,latest);
  const sent=[];
  const handler=createPasswordResetHandler({db,baseUrl:'https://randori.example.test',send:message=>{
    sent.push(message); return {providerName:'test'};
  }});
  const events=(await db.execute(`SELECT id,event_type,event_version,idempotency_key,payload_json
    FROM outbox_events ORDER BY id`)).rows;
  const outcomes=[];
  for(const row of events){
    outcomes.push(await handler({id:Number(row.id),eventType:row.event_type,
      eventVersion:Number(row.event_version),idempotencyKey:row.idempotency_key,
      payload:JSON.parse(row.payload_json)}));
  }
  assert.deepEqual(outcomes.slice(0,-1).map(item=>item.reasonCode),Array(4).fill('PASSWORD_RESET_INACTIVE'));
  assert.equal(outcomes.at(-1).status,'delivered');
  assert.equal(sent.length,1);
  const newHash=await bcrypt.hash('another correct horse',4);
  assert.deepEqual(await consumePasswordReset(db,{token:first,passwordHash:newHash},{nowSeconds:NOW+100}),{status:'invalid'});
  assert.deepEqual(await consumePasswordReset(db,{token:latest,passwordHash:newHash},{nowSeconds:NOW+2_100}),{status:'expired'});
});

test('one concurrent password-reset consumer wins',async()=>{
  const {db,databases}=await fixture({clients:2});
  await requestPasswordReset(db,{email:'member@example.test'},{nowSeconds:NOW});
  const {token}=await queuedToken(db);
  const hashes=await Promise.all([bcrypt.hash('first replacement',4),bcrypt.hash('second replacement',4)]);
  const outcomes=await Promise.allSettled(databases.map((database,index)=>
    consumePasswordReset(database,{token,passwordHash:hashes[index]},{nowSeconds:NOW+100})));
  assert.equal(outcomes.filter(item=>item.status==='fulfilled'&&item.value.status==='reset').length,1,
    JSON.stringify(outcomes.map(item=>item.status==='fulfilled'?item.value:{error:String(item.reason),code:item.reason?.code})));
  assert.equal(outcomes.filter(item=>item.status==='fulfilled'&&item.value.status==='used').length,1,
    JSON.stringify(outcomes.map(item=>item.status==='fulfilled'?item.value:{error:String(item.reason),code:item.reason?.code})));

});

test('password reset state survives a database restart',async()=>{
  const {db,url}=await fixture();
  await requestPasswordReset(db,{email:'member@example.test'},{nowSeconds:NOW});
  const restartToken=(await queuedToken(db)).token;
  db.close();
  const reopened=createClient({url});
  resources.push(()=>reopened.close());
  await prepareMigrationConnection(reopened);
  assert.deepEqual(await consumePasswordReset(reopened,{token:restartToken,
    passwordHash:await bcrypt.hash('restart replacement',4)},{nowSeconds:NOW+100}),{status:'reset'});
});

test('recent auth is session bound, method constrained, and expires after ten minutes',async()=>{
  const {db}=await fixture();
  const token=await issueSession(db,{id:1,email:'member@example.test',name:'Member'},
    {nowSeconds:NOW,recentAuthMethod:'password'});
  const sessionId=jwt.decode(token).jti;
  const sessionHash=(await db.execute({sql:`SELECT session_hash FROM auth_sessions WHERE user_id=1`})).rows[0].session_hash;
  assert.ok(sessionId);
  const payload=await verifyRequestAuth({headers:{authorization:`Bearer ${token}`}},db,{nowSeconds:NOW+1});
  assert.equal((await readRecentAuth(db,payload,{nowSeconds:NOW+1})).method,'password');
  assert.equal((await readRecentAuth(db,payload,{nowSeconds:NOW+601})).ok,false);
  await recordRecentAuth(db,{sessionHash,userId:1,method:'google',nowSeconds:NOW+601});
  assert.equal((await requireRecentAuth(db,payload,{nowSeconds:NOW+602})).method,'google');
  await assert.rejects(()=>recordRecentAuth(db,{sessionHash,userId:1,method:'email',nowSeconds:NOW+602}),TypeError);
});

test('production reset encryption fails closed and rejects tampering',()=>{
  process.env.JWT_SECRET=JWT_SECRET;
  process.env.NODE_ENV='production';
  delete process.env.PASSWORD_RESET_ENCRYPTION_KEY;
  assert.throws(()=>sealPasswordResetToken('A'.repeat(43)),/PASSWORD_RESET_ENCRYPTION_KEY/);
  process.env.PASSWORD_RESET_ENCRYPTION_KEY=ENCRYPTION_KEY;
  const envelope=sealPasswordResetToken('A'.repeat(43));
  const tampered=`${envelope.slice(0,-1)}${envelope.endsWith('A')?'B':'A'}`;
  assert.equal(openPasswordResetToken(tampered),null);
});
