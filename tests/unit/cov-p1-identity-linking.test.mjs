// Branch coverage for api/_identity-linking.js: fail-closed configuration and
// readiness, defensive email-hash state checks, retry/commit semantics, and the
// negative paths of every credential mutation. Uses a real migrated SQLite
// database; individual statements are intercepted only where a concurrent
// change or corrupted state cannot be produced through the public API.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,test} from 'node:test';

import {createClient} from '@libsql/client';
import bcrypt from 'bcryptjs';

import {issueSession,verifyRequestAuth} from '../../api/_db.js';
import {
  GOOGLE_ISSUER,
  addPasswordCredential,
  ensureIdentityLinkingReadiness,
  identityEmailHashConfiguration,
  identityEmailHashConfigured,
  identityEmailKeyMaterialStatus,
  linkGoogleCredential,
  observeGoogleProviderEmail,
  readIdentityState,
  unlinkGoogleCredential,
  unlinkPasswordCredential,
} from '../../api/_identity-linking.js';
import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';
import {
  adoptCredentialKeyControl,
  advanceCredentialKeyControl,
} from '../support/credential-key-control.mjs';

const resources=[];
const NOW=1_800_000_000;
const KEY_V1=Buffer.alloc(32,7).toString('base64url');
const KEY_V2=Buffer.alloc(32,8).toString('base64url');
const HEX_A='a'.repeat(64);
const HEX_B='b'.repeat(64);

afterEach(()=>{
  for(const name of ['CIRCLE_MEMBERSHIP_ENABLED','IDENTITY_EMAIL_HASH_KEY','IDENTITY_EMAIL_HASH_KEY_VERSION',
    'IDENTITY_EMAIL_HASH_PREVIOUS_KEYS','JWT_SECRET']) delete process.env[name];
  while(resources.length){ try{ resources.pop()(); }catch{} }
});

function configureKeyV1(){
  process.env.IDENTITY_EMAIL_HASH_KEY=KEY_V1;
  process.env.IDENTITY_EMAIL_HASH_KEY_VERSION='1';
  delete process.env.IDENTITY_EMAIL_HASH_PREVIOUS_KEYS;
}

function configureKeyV2(){
  process.env.IDENTITY_EMAIL_HASH_KEY=KEY_V2;
  process.env.IDENTITY_EMAIL_HASH_KEY_VERSION='2';
  process.env.IDENTITY_EMAIL_HASH_PREVIOUS_KEYS=JSON.stringify([{version:1,key:KEY_V1}]);
}

async function fixture(){
  process.env.JWT_SECRET='identity-linking-coverage-secret-at-least-32-bytes';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  configureKeyV1();
  const directory=mkdtempSync(join(tmpdir(),'randori-identity-cov-'));
  const db=createClient({url:`file:${join(directory,'database.sqlite')}`});
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  await adoptCredentialKeyControl(db,identityEmailHashConfiguration());
  resources.push(()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  return db;
}

async function addAccount(db,{id,email,password=true,googleSubject=null}){
  const passwordHash=password?await bcrypt.hash(`password-for-${id}`,4):`!oauth:account-${id}`;
  await db.execute({
    sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,google_sub)
      VALUES (?,?,?,?,?,?)`,
    args:[id,email,passwordHash,`Member ${id}`,'#123456',googleSubject],
  });
  if(googleSubject){
    await db.execute({sql:`INSERT INTO auth_provider_identities (issuer,subject,user_id) VALUES (?,?,?)`,
      args:[GOOGLE_ISSUER,googleSubject,id]});
  }
}

async function session(db,id,email,method='password',nowSeconds=NOW){
  const token=await issueSession(db,{id,email,name:`Member ${id}`},{recentAuthMethod:method,nowSeconds});
  const payload=await verifyRequestAuth({headers:{authorization:`Bearer ${token}`}},db,{nowSeconds});
  assert.ok(payload);
  return {token,payload};
}

async function count(db,sql,args=[]){
  return Number((await db.execute({sql:`SELECT COUNT(*) AS count FROM ${sql}`,args})).rows[0].count);
}

async function auditRows(db){
  return (await db.execute(`SELECT user_id,event_type,provider,outcome,reason_code
    FROM auth_identity_audit_events ORDER BY id`)).rows.map(row=>({...row}));
}

function sqlOf(statement){ return typeof statement==='string'?statement:statement.sql; }

// Wraps a real client so selected statements, transaction starts, or
// transaction lifecycle calls can be replaced. Rules are consumed in order;
// `times` limits how often a rule fires.
function intercept(db,{rules=[],onTransaction,commit,rollback,close,omitClose=false}={}){
  const calls={transactions:0,commits:0,rollbacks:0,closes:0};
  const matchRule=(statement)=>{
    const sql=sqlOf(statement);
    for(const rule of rules){
      if(!rule.match.test(sql)) continue;
      if(rule.times!==undefined){ if(rule.times<=0) continue; rule.times-=1; }
      return rule;
    }
    return null;
  };
  const execute=target=>async statement=>{
    const rule=matchRule(statement);
    if(rule?.error) throw rule.error();
    if(rule?.result) return typeof rule.result==='function'?rule.result(await target.execute(statement)):rule.result;
    return target.execute(statement);
  };
  const wrapped={
    calls,
    execute:execute(db),
    async transaction(mode){
      calls.transactions+=1;
      if(onTransaction) await onTransaction(calls.transactions);
      const tx=await db.transaction(mode);
      const wrappedTx={
        execute:execute(tx),
        async commit(){ calls.commits+=1; if(commit) return commit(tx); return tx.commit(); },
        async rollback(){ calls.rollbacks+=1; if(rollback) return rollback(tx); return tx.rollback(); },
      };
      if(!omitClose){
        wrappedTx.close=()=>{ calls.closes+=1; if(close) return close(tx); return tx.close(); };
      }else{
        resources.push(()=>tx.close());
      }
      return wrappedTx;
    },
  };
  return wrapped;
}

function busy(fields){ return Object.assign(new Error(fields.message||'busy'),fields); }

const ACCOUNT_STATE=/FROM auth_accounts account\s+LEFT JOIN auth_provider_identities/;
const EMAIL_STATE_GROUPS=/FROM auth_provider_email_state GROUP BY hash_key_version ORDER BY/;
const OBSERVE_PREVIOUS=/FROM auth_provider_identities identity\s+LEFT JOIN auth_provider_email_state/;

test('missing identity email hash configuration fails closed before any database access',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'member@example.test',googleSubject:'subject-one'});
  const {payload}=await session(db,1,'member@example.test');
  delete process.env.IDENTITY_EMAIL_HASH_KEY_VERSION;
  assert.equal(identityEmailHashConfigured(),false);
  assert.equal(identityEmailHashConfiguration(),null);
  await assert.rejects(ensureIdentityLinkingReadiness(db),/identity email hashing unavailable/);
  await assert.rejects(ensureIdentityLinkingReadiness(null),TypeError);
  await assert.rejects(ensureIdentityLinkingReadiness({}),TypeError);
  await assert.rejects(identityEmailKeyMaterialStatus(db),
    error=>error.code==='IDENTITY_EMAIL_HASH_CONFIGURATION_INVALID');
  await assert.rejects(identityEmailKeyMaterialStatus(null),TypeError);

  const guarded=intercept(db);
  await assert.rejects(linkGoogleCredential(guarded,payload,{issuer:GOOGLE_ISSUER,subject:'subject-two',
    providerEmail:'member@example.test',nowSeconds:NOW}),error=>error.code==='IDENTITY_EMAIL_HASH_UNAVAILABLE');
  await assert.rejects(observeGoogleProviderEmail(guarded,{issuer:GOOGLE_ISSUER,subject:'subject-one',userId:1,
    providerEmail:'member@example.test',nowSeconds:NOW}),error=>error.code==='IDENTITY_EMAIL_HASH_UNAVAILABLE');
  assert.equal(guarded.calls.transactions,0);
  assert.equal(await count(db,'auth_identity_audit_events'),0);
});

test('readiness rejects corrupt, mixed, future, and substituted stored email hash state',async()=>{
  const db=await fixture();
  const fingerprint=identityEmailHashConfiguration().fingerprint;
  const cases=[
    [[{hash_key_version:1,min_fingerprint:'not-hex',max_fingerprint:'not-hex'}],'IDENTITY_EMAIL_HASH_STATE_INVALID'],
    [[{hash_key_version:0,min_fingerprint:fingerprint,max_fingerprint:fingerprint}],'IDENTITY_EMAIL_HASH_STATE_INVALID'],
    [[{hash_key_version:'x',min_fingerprint:fingerprint,max_fingerprint:fingerprint}],'IDENTITY_EMAIL_HASH_STATE_INVALID'],
    [[{hash_key_version:1,min_fingerprint:null,max_fingerprint:null}],'IDENTITY_EMAIL_HASH_STATE_INVALID'],
    [[{hash_key_version:1,min_fingerprint:HEX_A,max_fingerprint:HEX_B}],'IDENTITY_EMAIL_HASH_STATE_INVALID'],
    [[{hash_key_version:2,min_fingerprint:HEX_A,max_fingerprint:HEX_A}],'IDENTITY_EMAIL_HASH_VERSION_ROLLBACK'],
    [[{hash_key_version:1,min_fingerprint:HEX_A,max_fingerprint:HEX_A}],'IDENTITY_EMAIL_HASH_KEY_SUBSTITUTION'],
  ];
  for(const [rows,code] of cases){
    const guarded=intercept(db,{rules:[{match:EMAIL_STATE_GROUPS,result:{rows}}]});
    await assert.rejects(ensureIdentityLinkingReadiness(guarded),error=>error.code===code,code);
  }
  await ensureIdentityLinkingReadiness(intercept(db,{rules:[{match:EMAIL_STATE_GROUPS,result:{}}]}));
  await ensureIdentityLinkingReadiness(intercept(db,{rules:[{match:EMAIL_STATE_GROUPS,
    result:{rows:[{hash_key_version:1,min_fingerprint:fingerprint,max_fingerprint:fingerprint}]}}]}));
});

test('readiness accepts rows hashed with a retained previous key and tolerates retired versions',async()=>{
  const db=await fixture();
  configureKeyV2();
  const configuration=identityEmailHashConfiguration();
  await advanceCredentialKeyControl(db,configuration,{expectedVersion:1,expectedGeneration:1});
  const previous=configuration.byVersion.get(1).fingerprint;
  await ensureIdentityLinkingReadiness(intercept(db,{rules:[{match:EMAIL_STATE_GROUPS,result:{rows:[
    {hash_key_version:2,min_fingerprint:configuration.fingerprint,max_fingerprint:configuration.fingerprint},
    {hash_key_version:1,min_fingerprint:previous,max_fingerprint:previous},
  ]}}]}));
  delete process.env.IDENTITY_EMAIL_HASH_PREVIOUS_KEYS;
  // A version whose key has been retired cannot be compared and is not a substitution.
  await ensureIdentityLinkingReadiness(intercept(db,{rules:[{match:EMAIL_STATE_GROUPS,result:{rows:[
    {hash_key_version:1,min_fingerprint:HEX_A,max_fingerprint:HEX_A},
  ]}}]}));
});

test('key material status counts future, substituted, and missing-key observations without exposing them',async()=>{
  const configuration=(configureKeyV2(),identityEmailHashConfiguration());
  const previous=configuration.byVersion.get(1).fingerprint;
  const fake=rows=>({execute:async()=>({rows})});
  const empty=await identityEmailKeyMaterialStatus({execute:async()=>({})},{configuration});
  assert.equal(empty.ready,true);
  assert.equal(empty.observations,0);
  assert.deepEqual(empty.previous_versions,[1]);

  const healthy=await identityEmailKeyMaterialStatus(fake([
    {hash_key_version:1,hash_key_fingerprint:previous,count:3},
    {hash_key_version:2,hash_key_fingerprint:configuration.fingerprint,count:4},
  ]),{configuration});
  assert.equal(healthy.ready,true);
  assert.deepEqual(healthy.versions,{1:3,2:4});

  const unhealthy=await identityEmailKeyMaterialStatus(fake([
    {hash_key_version:1,hash_key_fingerprint:HEX_A,count:2},
    {hash_key_version:2,hash_key_fingerprint:configuration.fingerprint,count:1},
    {hash_key_version:2,hash_key_fingerprint:HEX_B,count:5},
    {hash_key_version:3,hash_key_fingerprint:HEX_A,count:7},
  ]),{configuration});
  assert.equal(unhealthy.ready,false);
  assert.equal(unhealthy.fingerprint_mismatch,7);
  assert.equal(unhealthy.future_version,7);
  assert.equal(unhealthy.missing_key,0);
  assert.equal(unhealthy.observations,15);
  assert.deepEqual(unhealthy.versions,{1:2,2:6,3:7});
  assert.doesNotMatch(JSON.stringify(unhealthy),new RegExp(`${HEX_A}|${HEX_B}`));

  process.env.IDENTITY_EMAIL_HASH_PREVIOUS_KEYS='[]';
  const retired=identityEmailHashConfiguration();
  const missing=await identityEmailKeyMaterialStatus(fake([
    {hash_key_version:1,hash_key_fingerprint:previous,count:2},
  ]),{configuration:retired});
  assert.equal(missing.ready,false);
  assert.equal(missing.missing_key,2);

  const oversized=Array.from({length:10001},(_,index)=>({hash_key_version:2,
    hash_key_fingerprint:configuration.fingerprint,count:index}));
  await assert.rejects(identityEmailKeyMaterialStatus(fake(oversized),{configuration}),
    error=>error.code==='IDENTITY_EMAIL_HASH_STATE_INVALID');
});

test('per-identity email comparison fails closed on corrupt, future, and substituted prior observations',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'member@example.test',googleSubject:'subject-one'});
  const v1=identityEmailHashConfiguration().fingerprint;
  const observe=(client,email='member@example.test')=>observeGoogleProviderEmail(client,{issuer:GOOGLE_ISSUER,
    subject:'subject-one',userId:1,providerEmail:email,nowSeconds:NOW});
  const cases=[
    [{email_hash:'not-a-hash',hash_key_version:1,hash_key_fingerprint:v1},'IDENTITY_EMAIL_HASH_STATE_INVALID'],
    [{email_hash:HEX_A,hash_key_version:0,hash_key_fingerprint:v1},'IDENTITY_EMAIL_HASH_STATE_INVALID'],
    [{email_hash:HEX_A,hash_key_version:2,hash_key_fingerprint:v1},'IDENTITY_EMAIL_HASH_VERSION_ROLLBACK'],
    [{email_hash:HEX_A,hash_key_version:1,hash_key_fingerprint:HEX_B},'IDENTITY_EMAIL_HASH_KEY_SUBSTITUTION'],
    [{email_hash:HEX_A,hash_key_version:1,hash_key_fingerprint:null},'IDENTITY_EMAIL_HASH_KEY_SUBSTITUTION'],
  ];
  for(const [row,code] of cases){
    await assert.rejects(observe(intercept(db,{rules:[{match:OBSERVE_PREVIOUS,result:{rows:[row]}}]})),
      error=>error.code===code,code);
  }

  configureKeyV2();
  await advanceCredentialKeyControl(db,identityEmailHashConfiguration(),{expectedVersion:1,expectedGeneration:1});
  await assert.rejects(observe(intercept(db,{rules:[{match:OBSERVE_PREVIOUS,result:{rows:[
    {email_hash:HEX_A,hash_key_version:1,hash_key_fingerprint:HEX_B},
  ]}}]})),error=>error.code==='IDENTITY_EMAIL_HASH_KEY_SUBSTITUTION');
  // Nothing was persisted by any rejected observation.
  assert.equal(await count(db,'auth_provider_email_state'),0);
  assert.equal(await count(db,'auth_identity_audit_events'),0);
});

test('provider email observation validates input and requires the identity to belong to the user',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'member@example.test',googleSubject:'subject-one'});
  await addAccount(db,{id:2,email:'other@example.test'});
  const base={issuer:GOOGLE_ISSUER,subject:'subject-one',userId:1,providerEmail:'member@example.test',nowSeconds:NOW};
  for(const override of [{issuer:'https://evil.example'},{subject:'bad subject'},{subject:''},{userId:0},
    {userId:'1.5'},{providerEmail:'not-an-email'},{providerEmail:undefined}]){
    await assert.rejects(observeGoogleProviderEmail(db,{...base,...override}),
      /valid Google email observation is required/,JSON.stringify(override));
  }
  await assert.rejects(observeGoogleProviderEmail({},base),TypeError);
  await assert.rejects(observeGoogleProviderEmail(db),TypeError);
  await assert.rejects(observeGoogleProviderEmail(db,{...base,userId:2}),/provider identity unavailable/);
  await assert.rejects(observeGoogleProviderEmail(db,{...base,subject:'unknown-subject'}),/provider identity unavailable/);
  assert.equal(await count(db,'auth_provider_email_state'),0);
});

test('identity time must be a positive integer override or a valid database clock',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'member@example.test',googleSubject:'subject-one'});
  const realNow=Math.floor(Date.now()/1000);
  const current=await session(db,1,'member@example.test','password',realNow);
  for(const nowSeconds of [-1,1.5,'1800000000',0]){
    await assert.rejects(unlinkGoogleCredential(db,current.payload,{nowSeconds}),
      /valid identity time is required/,String(nowSeconds));
  }
  await assert.rejects(unlinkGoogleCredential(intercept(db,{rules:[{match:/strftime\('%s','now'\)/,
    result:{rows:[{now_seconds:null}]}}]}),current.payload),/database identity time unavailable/);
  await assert.rejects(unlinkGoogleCredential(intercept(db,{rules:[{match:/strftime\('%s','now'\)/,
    result:{rows:[]}}]}),current.payload),/database identity time unavailable/);
  // Without an override the database clock is used and the fresh proof is accepted.
  const result=await unlinkGoogleCredential(db,current.payload);
  assert.equal(result.status,'unlinked');
  assert.equal(await count(db,'auth_provider_identities'),0);
});

test('identity state reads accept uid payloads and reject malformed sessions or missing accounts',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'member@example.test',password:false,googleSubject:'subject-one'});
  const {payload}=await session(db,1,'member@example.test','google');
  const viaUid=await readIdentityState(db,{uid:1,sessionHash:payload.sessionHash},{nowSeconds:NOW});
  assert.deepEqual({...viaUid.password},{linked:false,canAdd:true,canUnlink:false});
  assert.deepEqual({...viaUid.google},{linked:true,canLink:false,canUnlink:false});
  assert.equal(viaUid.recentAuth.method,'google');
  // A proof dated after the real clock is never treated as recent.
  const defaultClock=await readIdentityState(db,payload);
  assert.equal(defaultClock.recentAuth.ok,false);

  await assert.rejects(readIdentityState(db,{id:1,sessionHash:'short'}),/valid identity session is required/);
  await assert.rejects(readIdentityState(db,{id:1}),/valid identity session is required/);
  await assert.rejects(readIdentityState(db,null),/valid identity session is required/);
  await assert.rejects(readIdentityState(db,{id:-1,sessionHash:payload.sessionHash}),/valid identity session is required/);
  await assert.rejects(readIdentityState(db,{id:99,sessionHash:payload.sessionHash}),/identity account unavailable/);
  await assert.rejects(readIdentityState(intercept(db,{rules:[{match:ACCOUNT_STATE,result:{rows:[{},{}]}}]}),
    payload,{nowSeconds:NOW}),/identity account unavailable/);
});

test('Google link rejects malformed proofs before opening a transaction',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'member@example.test'});
  const {payload}=await session(db,1,'member@example.test');
  const guarded=intercept(db);
  const proof={issuer:GOOGLE_ISSUER,subject:'subject-one',providerEmail:'member@example.test',nowSeconds:NOW};
  for(const [label,client,body,input] of [
    ['issuer',guarded,payload,{...proof,issuer:'https://accounts.google.com/'}],
    ['subject',guarded,payload,{...proof,subject:'has.dot'}],
    ['long subject',guarded,payload,{...proof,subject:'s'.repeat(256)}],
    ['email',guarded,payload,{...proof,providerEmail:'nope'}],
    ['session',guarded,{...payload,sessionHash:'A'.repeat(64)},proof],
    ['user',guarded,{sessionHash:payload.sessionHash},proof],
    ['database',{},payload,proof],
  ]){
    await assert.rejects(linkGoogleCredential(client,body,input),/valid explicit Google link proof is required/,label);
  }
  await assert.rejects(linkGoogleCredential(guarded,payload),TypeError);
  assert.equal(guarded.calls.transactions,0);
});

test('an account already linked to a different Google subject cannot be relinked and the conflict is audited',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'member@example.test',googleSubject:'original-subject'});
  const {payload}=await session(db,1,'member@example.test');
  const result=await linkGoogleCredential(db,{uid:1,sessionHash:payload.sessionHash},{issuer:GOOGLE_ISSUER,
    subject:'replacement-subject',providerEmail:'member@example.test',nowSeconds:NOW});
  assert.equal(result.status,'provider_already_linked');
  assert.deepEqual((await db.execute(`SELECT subject,user_id FROM auth_provider_identities`)).rows.map(row=>({...row})),
    [{subject:'original-subject',user_id:1}]);
  assert.equal((await db.execute(`SELECT google_sub FROM auth_accounts WHERE id=1`)).rows[0].google_sub,'original-subject');
  assert.deepEqual(await auditRows(db),[{user_id:1,event_type:'link_conflict',provider:'google',outcome:'conflict',
    reason_code:'provider_already_linked'}]);
});

test('relinking the same subject reports already_linked, observes provider email changes, and rekeys on rotation',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'canonical@example.test',googleSubject:'stable-subject'});
  const {payload}=await session(db,1,'canonical@example.test');
  const link=(email,nowSeconds)=>linkGoogleCredential(db,payload,{issuer:GOOGLE_ISSUER,subject:'stable-subject',
    providerEmail:email,nowSeconds});

  assert.equal((await link('canonical@example.test',NOW)).status,'already_linked');
  assert.equal((await link('rotated@example.test',NOW+1)).status,'already_linked');
  let state=(await db.execute(`SELECT hash_key_version,changed_at,observed_at FROM auth_provider_email_state`)).rows[0];
  assert.equal(Number(state.changed_at),NOW+1);
  assert.equal(Number(state.observed_at),NOW+1);

  configureKeyV2();
  await advanceCredentialKeyControl(db,identityEmailHashConfiguration(),{expectedVersion:1,expectedGeneration:1});
  assert.equal((await link('rotated@example.test',NOW+2)).status,'already_linked');
  state=(await db.execute(`SELECT hash_key_version,changed_at FROM auth_provider_email_state`)).rows[0];
  assert.equal(Number(state.hash_key_version),2);
  assert.equal(Number(state.changed_at),NOW+1);

  assert.deepEqual((await auditRows(db)).map(row=>`${row.event_type}:${row.reason_code}`),[
    'google_linked:same_email_explicit_link',
    'provider_email_changed:provider_email_rotated',
    'google_linked:explicit_link',
    'provider_email_rekeyed:hash_key_rotated',
    'google_linked:explicit_link',
  ]);
  assert.doesNotMatch(JSON.stringify((await db.execute(`SELECT * FROM auth_provider_email_state`)).rows),/@example/);
});

test('linking with a different provider email records an explicit link rather than recovery',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'canonical@example.test'});
  const {payload}=await session(db,1,'canonical@example.test');
  const result=await linkGoogleCredential(db,payload,{issuer:GOOGLE_ISSUER,subject:'fresh-subject',
    providerEmail:'Other@Example.test',nowSeconds:NOW});
  assert.equal(result.status,'linked');
  assert.deepEqual(await auditRows(db),[{user_id:1,event_type:'google_linked',provider:'google',
    outcome:'succeeded',reason_code:'explicit_link'}]);
  assert.equal((await readIdentityState(db,payload,{nowSeconds:NOW})).recentAuth.method,'google');
});

test('concurrent ownership changes inside the link transaction resolve to provider_in_use without partial writes',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'member@example.test'});
  const {payload}=await session(db,1,'member@example.test');
  const proof={issuer:GOOGLE_ISSUER,subject:'contested-subject',providerEmail:'member@example.test',nowSeconds:NOW};
  for(const rule of [
    {match:/UPDATE auth_accounts SET google_sub=\?/,result:{rows:[]}},
    {match:/INSERT INTO auth_provider_identities/,result:{rows:[{user_id:2}]}},
    {match:/INSERT INTO auth_provider_identities/,result:{rows:[]}},
  ]){
    const result=await linkGoogleCredential(intercept(db,{rules:[rule]}),payload,proof);
    assert.equal(result.status,'provider_in_use');
  }
  assert.equal(await count(db,'auth_provider_identities'),0);
  assert.equal((await db.execute(`SELECT google_sub FROM auth_accounts WHERE id=1`)).rows[0].google_sub,null);
  assert.deepEqual((await auditRows(db)).map(row=>row.reason_code),['provider_in_use','provider_in_use','provider_in_use']);
});

test('a missing account inside a mutation transaction fails closed and rolls back',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'member@example.test',googleSubject:'subject-one'});
  const {payload}=await session(db,1,'member@example.test','google');
  const missing=()=>intercept(db,{rules:[{match:ACCOUNT_STATE,result:{rows:[]}}]});
  await assert.rejects(linkGoogleCredential(missing(),payload,{issuer:GOOGLE_ISSUER,subject:'subject-one',
    providerEmail:'member@example.test',nowSeconds:NOW}),/identity account unavailable/);
  await assert.rejects(unlinkGoogleCredential(missing(),payload,{nowSeconds:NOW}),/identity account unavailable/);
  await assert.rejects(addPasswordCredential(missing(),payload,{passwordHash:'$2b$04$abcdefghijklmnopqrstuv',
    nowSeconds:NOW}),/identity account unavailable/);
  await assert.rejects(unlinkPasswordCredential(missing(),payload,{nowSeconds:NOW}),/identity account unavailable/);
  assert.equal(await count(db,'auth_identity_audit_events'),0);
  assert.equal(await count(db,'auth_provider_identities'),1);
});

test('transient lock errors before commit are retried with backoff until the link succeeds',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'member@example.test'});
  const {payload}=await session(db,1,'member@example.test');
  const failures=[
    busy({rawCode:'sqlite_busy'}),
    busy({message:'SQLITE_BUSY: database is locked'}),
    busy({message:'database table is locked'}),
    busy({message:'wrapper',cause:busy({message:'inner',code:'LIBSQL_TRANSACTION_BUSY'})}),
  ];
  const guarded=intercept(db,{onTransaction:attempt=>{ if(attempt<=failures.length) throw failures[attempt-1]; }});
  const result=await linkGoogleCredential(guarded,payload,{issuer:GOOGLE_ISSUER,subject:'retry-subject',
    providerEmail:'member@example.test',nowSeconds:NOW});
  assert.equal(result.status,'linked');
  assert.equal(guarded.calls.transactions,failures.length+1);
  assert.equal(await count(db,'auth_provider_identities'),1);
});

test('non-transient errors, exhausted retries, and commit failures are not retried',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'member@example.test'});
  const {payload}=await session(db,1,'member@example.test');
  const proof={issuer:GOOGLE_ISSUER,subject:'retry-subject',providerEmail:'member@example.test',nowSeconds:NOW};

  const fatal=intercept(db,{onTransaction:()=>{ throw new Error('disk full'); }});
  await assert.rejects(linkGoogleCredential(fatal,payload,proof),error=>error.message==='disk full'
    &&error.identityLinkRetryable===undefined);
  assert.equal(fatal.calls.transactions,1);

  const deepCause=intercept(db,{onTransaction:()=>{
    let error=busy({message:'level-0'});
    for(let depth=1;depth<8;depth+=1) error=busy({message:`level-${depth}`,cause:error});
    error.cause.cause.cause.cause.cause.cause.cause.code='SQLITE_BUSY';
    throw error;
  }});
  await assert.rejects(linkGoogleCredential(deepCause,payload,proof),/level-7/);
  assert.equal(deepCause.calls.transactions,1,'conflict codes deeper than six causes are not trusted');

  const exhausted=intercept(db,{onTransaction:()=>{ throw busy({code:'SQLITE_BUSY'}); }});
  await assert.rejects(linkGoogleCredential(exhausted,payload,proof),error=>error.identityLinkRetryable===true);
  assert.equal(exhausted.calls.transactions,8);

  const commitFailure=intercept(db,{commit:async()=>{ throw busy({code:'SQLITE_BUSY'}); }});
  await assert.rejects(linkGoogleCredential(commitFailure,payload,proof),error=>error.code==='SQLITE_BUSY'
    &&error.identityLinkRetryable===undefined);
  assert.equal(commitFailure.calls.transactions,1,'an ambiguous commit is never replayed');
  assert.equal(commitFailure.calls.rollbacks,1);
  assert.equal(await count(db,'auth_provider_identities'),0);
});

test('transaction close and rollback failures never mask the outcome',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'member@example.test'});
  await addAccount(db,{id:2,email:'google@example.test',password:false,googleSubject:'google-subject'});
  const {payload}=await session(db,1,'member@example.test');

  const closeFails=intercept(db,{close:async tx=>{ tx.close(); throw new Error('close failed'); }});
  const linked=await linkGoogleCredential(closeFails,payload,{issuer:GOOGLE_ISSUER,subject:'close-subject',
    providerEmail:'member@example.test',nowSeconds:NOW});
  assert.equal(linked.status,'linked');
  assert.equal(closeFails.calls.closes,1);

  const rollbackFails=intercept(db,{rules:[{match:ACCOUNT_STATE,result:{rows:[]}}],
    rollback:async tx=>{ await tx.rollback(); throw new Error('rollback failed'); },
    close:async tx=>{ tx.close(); throw new Error('close failed'); }});
  await assert.rejects(unlinkGoogleCredential(rollbackFails,payload,{nowSeconds:NOW}),/identity account unavailable/);
  assert.equal(rollbackFails.calls.rollbacks,1);

  const noClose=intercept(db,{omitClose:true});
  const google=await session(db,2,'google@example.test','google');
  assert.equal((await unlinkPasswordCredential(noClose,google.payload,{nowSeconds:NOW})).status,'not_linked');
  assert.equal((await unlinkGoogleCredential(noClose,payload,{nowSeconds:NOW})).status,'unlinked');
});

test('conflict audits outside the link transaction retry transient locks and surface persistence failures',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'member@example.test'});
  await addAccount(db,{id:2,email:'owner@example.test',password:false,googleSubject:'owned-subject'});
  const {payload}=await session(db,1,'member@example.test');
  const proof={issuer:GOOGLE_ISSUER,subject:'owned-subject',providerEmail:'member@example.test',nowSeconds:NOW};

  const flaky=intercept(db,{onTransaction:attempt=>{ if(attempt===2) throw busy({code:'SQLITE_LOCKED'}); }});
  assert.equal((await linkGoogleCredential(flaky,payload,proof)).status,'provider_in_use');
  assert.equal(flaky.calls.transactions,3);
  assert.equal(await count(db,'auth_identity_audit_events'),1);

  const fatal=intercept(db,{onTransaction:attempt=>{ if(attempt===2) throw new Error('audit store offline'); }});
  await assert.rejects(linkGoogleCredential(fatal,payload,proof),/audit store offline/);

  const auditCommit=intercept(db,{commit:async()=>{ throw busy({code:'SQLITE_BUSY'}); }});
  await assert.rejects(linkGoogleCredential(auditCommit,payload,proof),error=>error.code==='SQLITE_BUSY');
  // persistAudit never replays its own commit; the busy error does make the
  // whole link attempt retryable, so each of the 8 link attempts re-decides
  // the conflict and issues exactly one audit commit.
  assert.equal(auditCommit.calls.transactions,16);
  assert.equal(auditCommit.calls.commits,8);
  assert.equal(await count(db,'auth_identity_audit_events'),1);

  const lostAudit=intercept(db,{rules:[{match:/INSERT INTO auth_identity_audit_events/,result:{rows:[]}}]});
  await assert.rejects(linkGoogleCredential(lostAudit,payload,proof),/identity audit persistence failed/);
  assert.equal(await count(db,'auth_identity_audit_events'),1);
});

test('Google unlink validates the session, reports not_linked, and fails closed on concurrent changes',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'dual@example.test',googleSubject:'dual-subject'});
  await addAccount(db,{id:2,email:'password@example.test'});
  const dual=await session(db,1,'dual@example.test');
  const passwordOnly=await session(db,2,'password@example.test');
  for(const [client,body] of [[{},dual.payload],[db,{id:1}],[db,{id:0,sessionHash:dual.payload.sessionHash}],[db,null]]){
    await assert.rejects(unlinkGoogleCredential(client,body,{nowSeconds:NOW}),/valid identity session is required/);
  }
  assert.equal((await unlinkGoogleCredential(db,{uid:2,sessionHash:passwordOnly.payload.sessionHash},
    {nowSeconds:NOW})).status,'not_linked');

  for(const rule of [
    {match:/DELETE FROM auth_provider_identities/,result:{rows:[]}},
    {match:/UPDATE auth_accounts SET google_sub=NULL/,result:{rows:[]}},
  ]){
    await assert.rejects(unlinkGoogleCredential(intercept(db,{rules:[rule]}),dual.payload,{nowSeconds:NOW}),
      /provider unlink changed concurrently/);
  }
  assert.equal(await count(db,'auth_provider_identities'),1);
  assert.equal((await db.execute(`SELECT google_sub FROM auth_accounts WHERE id=1`)).rows[0].google_sub,'dual-subject');

  await assert.rejects(unlinkGoogleCredential(intercept(db,{rules:[{match:/INSERT INTO auth_identity_audit_events/,
    result:{rows:[]}}]}),dual.payload,{nowSeconds:NOW}),/identity audit persistence failed/);
  assert.equal(await count(db,'auth_provider_identities'),1,'an unaudited unlink is rolled back');
  assert.equal(await count(db,'auth_identity_audit_events'),0);
});

test('adding a password requires a bcrypt hash, a Google identity, and a recent Google proof',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'google@example.test',password:false,googleSubject:'google-subject'});
  await addAccount(db,{id:2,email:'nogoogle@example.test',password:false});
  await addAccount(db,{id:3,email:'dual@example.test',googleSubject:'dual-subject'});
  const googleProof=await session(db,1,'google@example.test','google');
  const passwordProof=await session(db,1,'google@example.test','password');
  const noGoogle=await session(db,2,'nogoogle@example.test','google');
  const dual=await session(db,3,'dual@example.test','google');
  const passwordHash=await bcrypt.hash('replacement password',4);

  for(const [client,body,hash] of [
    [db,googleProof.payload,'plaintext'],[db,googleProof.payload,undefined],[db,googleProof.payload,`$2${'x'.repeat(127)}`],
    [db,{id:1},passwordHash],[db,{id:1,sessionHash:'z'},passwordHash],[{},googleProof.payload,passwordHash],
  ]){
    await assert.rejects(addPasswordCredential(client,body,{passwordHash:hash,nowSeconds:NOW}),
      /valid password credential is required/);
  }
  await assert.rejects(addPasswordCredential(db,googleProof.payload),TypeError);

  assert.equal((await addPasswordCredential(db,dual.payload,{passwordHash,nowSeconds:NOW})).status,'already_linked');
  assert.equal((await addPasswordCredential(db,passwordProof.payload,{passwordHash,nowSeconds:NOW})).status,
    'verified_control_required');
  assert.equal((await addPasswordCredential(db,{uid:2,sessionHash:noGoogle.payload.sessionHash},
    {passwordHash,nowSeconds:NOW})).status,'verified_control_required');
  await assert.rejects(addPasswordCredential(intercept(db,{rules:[{match:/UPDATE auth_accounts SET password_hash=\?/,
    result:{rows:[]}}]}),googleProof.payload,{passwordHash,nowSeconds:NOW}),/password link changed concurrently/);

  const hashes=(await db.execute(`SELECT id,password_hash FROM auth_accounts WHERE id IN (1,2) ORDER BY id`)).rows;
  assert.ok(hashes.every(row=>!String(row.password_hash).startsWith('$2')));
  assert.deepEqual((await auditRows(db)).map(row=>`${row.user_id}:${row.event_type}:${row.reason_code}`),[
    '1:link_conflict:verified_control_required','2:link_conflict:verified_control_required',
  ]);
});

test('password unlink validates the session, reports not_linked, and fails closed on concurrent changes',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'dual@example.test',googleSubject:'dual-subject'});
  await addAccount(db,{id:2,email:'google@example.test',password:false,googleSubject:'google-subject'});
  const dual=await session(db,1,'dual@example.test','google');
  const google=await session(db,2,'google@example.test','google');
  for(const [client,body] of [[{},dual.payload],[db,{id:1}],[db,{sessionHash:dual.payload.sessionHash}],[db,undefined]]){
    await assert.rejects(unlinkPasswordCredential(client,body,{nowSeconds:NOW}),/valid identity session is required/);
  }
  assert.equal((await unlinkPasswordCredential(db,{uid:2,sessionHash:google.payload.sessionHash},
    {nowSeconds:NOW})).status,'not_linked');
  await assert.rejects(unlinkPasswordCredential(intercept(db,{rules:[{match:/UPDATE auth_accounts SET password_hash=\?/,
    result:{rows:[]}}]}),dual.payload,{nowSeconds:NOW}),/password unlink changed concurrently/);
  assert.ok(String((await db.execute(`SELECT password_hash FROM auth_accounts WHERE id=1`)).rows[0].password_hash)
    .startsWith('$2'));
  assert.equal(await count(db,'auth_identity_audit_events'),0);
});
