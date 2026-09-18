import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,test} from 'node:test';
import {createClient} from '@libsql/client';
import jwt from 'jsonwebtoken';

import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  SESSION_TTL_SECONDS,
  hashSessionIdentifier,
  issueSession,
  issueSessionInTransaction,
  revokeAccountSessions,
  revokeRequestSession,
  verifyRequestAuth,
  verifySignedRequestAuth,
} from '../../api/_db.js';
import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const JWT_SECRET='durable-session-test-secret-at-least-thirty-two-bytes';
const originalEnvironment={
  JWT_SECRET:process.env.JWT_SECRET,
  CIRCLE_MEMBERSHIP_ENABLED:process.env.CIRCLE_MEMBERSHIP_ENABLED,
};
const resources=[];

afterEach(async()=>{
  while(resources.length){
    try{ await resources.pop()(); }catch{}
  }
  for(const [key,value] of Object.entries(originalEnvironment)){
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
});

async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-auth-sessions-'));
  const url=`file:${join(directory,'database.sqlite')}`;
  const db=createClient({url});
  resources.push(async()=>{ await db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db,{migrations:EXECUTABLE_MIGRATIONS});
  await applyMigrations(db,{migrations:EXECUTABLE_MIGRATIONS,expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY});
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
      (1,'one@example.test','hash','One','#123456'),
      (2,'two@example.test','hash','Two','#654321')`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary) VALUES (1,'circle-one','randori-circle','Circle',1)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES
      (1,1,'member','active'),(1,2,'member','active')`,
  ],'write');
  process.env.JWT_SECRET=JWT_SECRET;
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  return {db,url,directory};
}

function request(token,transport='cookie'){
  return transport==='bearer'
    ? {headers:{authorization:`Bearer ${token}`}}
    : {headers:{cookie:`randori_session=${encodeURIComponent(token)}`}};
}

test('durable sessions store only hashes and isolate cookie and Bearer revocation',async()=>{
  const {db}=await fixture();
  const cookieToken=await issueSession(db,{id:1,email:'one@example.test',name:'One'});
  const bearerToken=await issueSession(db,{id:1,email:'one@example.test',name:'One'});
  const otherToken=await issueSession(db,{id:2,email:'two@example.test',name:'Two'});
  const cookieId=jwt.decode(cookieToken)?.jti;
  const bearerId=jwt.decode(bearerToken)?.jti;

  assert.match(cookieId,/^[A-Za-z0-9_-]{43}$/);
  const stored=await db.execute(`SELECT session_hash,user_id,created_at,expires_at,revoked_at FROM auth_sessions ORDER BY user_id,session_hash`);
  assert.equal(stored.rows.length,3);
  assert.ok(stored.rows.every(row=>/^[a-f0-9]{64}$/.test(String(row.session_hash))));
  assert.ok(stored.rows.every(row=>!String(row.session_hash).includes(cookieToken)&&String(row.session_hash)!==cookieId));
  assert.ok(stored.rows.every(row=>Number(row.expires_at)-Number(row.created_at)===SESSION_TTL_SECONDS));

  assert.equal((await verifyRequestAuth(request(cookieToken),db))?.authTransport,'cookie');
  assert.equal((await verifyRequestAuth(request(bearerToken,'bearer'),db))?.authTransport,'bearer');
  assert.equal(JSON.stringify(await verifyRequestAuth(request(cookieToken),db)).includes('sessionHash'),false);

  const invalidBearer=request(cookieToken);
  invalidBearer.headers.authorization='Bearer not-a-token';
  assert.equal(await verifyRequestAuth(invalidBearer,db),null,'invalid Bearer must not fall back to a valid cookie');

  assert.deepEqual(await revokeRequestSession(db,request(cookieToken)),{authenticated:true,revoked:true,userId:1});
  assert.equal(await verifyRequestAuth(request(cookieToken),db),null);
  assert.equal((await verifyRequestAuth(request(bearerToken,'bearer'),db))?.id,1);

  assert.equal(await revokeAccountSessions(db,1,'logout_all'),1);
  assert.equal(await verifyRequestAuth(request(bearerToken,'bearer'),db),null);
  assert.equal((await verifyRequestAuth(request(otherToken),db))?.id,2);
  assert.notEqual(hashSessionIdentifier(bearerId),bearerId);
});

test('expiry, malformed legacy credentials, and session-store failures fail closed',async()=>{
  const {db}=await fixture();
  const now=2_000_000_000;
  const token=await issueSession(db,{id:1,email:'one@example.test'},{nowSeconds:now});
  assert.equal((await verifyRequestAuth(request(token),db,{nowSeconds:now+SESSION_TTL_SECONDS-1}))?.id,1);
  assert.equal(await verifyRequestAuth(request(token),db,{nowSeconds:now+SESSION_TTL_SECONDS}),null);

  const legacy=jwt.sign({id:1},JWT_SECRET,{
    algorithm:'HS256',issuer:JWT_ISSUER,audience:JWT_AUDIENCE,expiresIn:'5m',
  });
  assert.equal(verifySignedRequestAuth(request(legacy)),null);
  await assert.rejects(
    verifyRequestAuth(request(token),{execute:async()=>{ throw new Error('database offline'); }},{nowSeconds:now}),
    /database offline/,
  );
});

test('logout-all is concurrent and durable across a database restart',async()=>{
  const {db,url,directory}=await fixture();
  const first=await issueSession(db,{id:1,email:'one@example.test'});
  const second=await issueSession(db,{id:1,email:'one@example.test'});
  const revoked=await Promise.all([
    revokeAccountSessions(db,1,'logout_all'),
    revokeAccountSessions(db,1,'logout_all'),
  ]);
  assert.equal(revoked.reduce((sum,count)=>sum+count,0),2);
  assert.equal(await verifyRequestAuth(request(first),db),null);

  await db.close();
  resources.pop();
  const reopened=createClient({url});
  resources.push(async()=>{ await reopened.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(reopened);
  assert.equal(await verifyRequestAuth(request(first),reopened),null);
  assert.equal(await verifyRequestAuth(request(second,'bearer'),reopened),null);
});

test('session issuance caps active sessions and security-event reasons revoke account-wide',async()=>{
  const {db}=await fixture();
  const now=2_000_000_000;
  const tokens=[];
  for(let index=0;index<9;index+=1){
    tokens.push(await issueSession(db,{id:1,email:'one@example.test'},{nowSeconds:now+index}));
  }
  const active=await db.execute({sql:`SELECT COUNT(*) AS count FROM auth_sessions
    WHERE user_id=1 AND revoked_at IS NULL AND expires_at>?`,args:[now+8]});
  assert.equal(Number(active.rows[0].count),8);
  assert.equal(await verifyRequestAuth(request(tokens[0]),db,{nowSeconds:now+8}),null);
  assert.equal((await verifyRequestAuth(request(tokens.at(-1)),db,{nowSeconds:now+8}))?.id,1);
  const rotated=await db.execute(`SELECT revocation_reason FROM auth_sessions
    WHERE user_id=1 AND revoked_at IS NOT NULL`);
  assert.deepEqual(rotated.rows.map(row=>String(row.revocation_reason)),['rotation']);

  assert.equal(await revokeAccountSessions(db,1,'password_change',{nowSeconds:now+9}),8);
  assert.equal(await verifyRequestAuth(request(tokens.at(-1)),db,{nowSeconds:now+9}),null);
  await assert.rejects(revokeAccountSessions(db,1,'untrusted_reason'),/valid session revocation/);
});

test('membership loss revokes every active session before private access',async()=>{
  const {db}=await fixture();
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  const first=await issueSession(db,{id:1,email:'one@example.test'});
  const second=await issueSession(db,{id:1,email:'one@example.test'});
  assert.equal((await verifyRequestAuth(request(first),db))?.id,1);

  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=1 AND user_id=1`);
  assert.equal(await verifyRequestAuth(request(first),db),null);
  assert.equal(await verifyRequestAuth(request(second),db),null);
  const rows=await db.execute(`SELECT revoked_at,revocation_reason FROM auth_sessions WHERE user_id=1`);
  assert.equal(rows.rows.length,2);
  assert.ok(rows.rows.every(row=>Number(row.revoked_at)>0&&row.revocation_reason==='membership_removed'));
});

test('identity updates, account revocation, and replacement issuance share one rollback boundary',async()=>{
  const {db}=await fixture();
  const oldToken=await issueSession(db,{id:1,email:'one@example.test'});

  const rolledBack=await db.transaction('write');
  await rolledBack.execute({
    sql:`UPDATE auth_accounts SET email=? WHERE id=? AND lower(email)=?`,
    args:['new@example.test',1,'one@example.test'],
  });
  await revokeAccountSessions(rolledBack,1,'identity_change');
  const discardedToken=await issueSessionInTransaction(rolledBack,{id:1,email:'new@example.test'});
  await rolledBack.rollback();
  assert.equal((await verifyRequestAuth(request(oldToken),db))?.id,1);
  assert.equal(await verifyRequestAuth(request(discardedToken),db),null);

  const committed=await db.transaction('write');
  await committed.execute({
    sql:`UPDATE auth_accounts SET email=? WHERE id=? AND lower(email)=?`,
    args:['new@example.test',1,'one@example.test'],
  });
  await revokeAccountSessions(committed,1,'identity_change');
  const replacementToken=await issueSessionInTransaction(committed,{id:1,email:'new@example.test'});
  await committed.commit();
  assert.equal(await verifyRequestAuth(request(oldToken),db),null);
  assert.equal((await verifyRequestAuth(request(replacementToken),db))?.email,'new@example.test');
  await assert.rejects(
    issueSession(db,{id:1,email:'one@example.test'}),
    /session persistence failed/,
    'a stale pre-change callback must not create a session after the identity update',
  );
});
