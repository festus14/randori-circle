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
  identityEmailHashConfiguration,
  linkGoogleCredential,
  identityEmailKeyRotationStatus,
  observeGoogleProviderEmail,
  readIdentityState,
  unlinkGoogleCredential,
  unlinkPasswordCredential,
} from '../../api/_identity-linking.js';
import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';
import {
  adoptCredentialKeyControl,
  advanceCredentialKeyControl,
} from '../support/credential-key-control.mjs';

const resources=[];
const NOW=1_800_000_000;

afterEach(()=>{
  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
  delete process.env.IDENTITY_EMAIL_HASH_KEY;
  delete process.env.IDENTITY_EMAIL_HASH_KEY_VERSION;
  delete process.env.IDENTITY_EMAIL_HASH_PREVIOUS_KEYS;
  delete process.env.JWT_SECRET;
  while(resources.length){ try{ resources.pop()(); }catch{} }
});

async function fixture(){
  process.env.JWT_SECRET='identity-linking-tests-secret-at-least-32-bytes';
  process.env.IDENTITY_EMAIL_HASH_KEY=Buffer.alloc(32,7).toString('base64url');
  process.env.IDENTITY_EMAIL_HASH_KEY_VERSION='1';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  const directory=mkdtempSync(join(tmpdir(),'randori-identity-linking-'));
  const databaseUrl=`file:${join(directory,'database.sqlite')}`;
  const db=createClient({url:databaseUrl});
  Object.defineProperty(db,'testDatabaseUrl',{value:databaseUrl});
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
  const payload=await verifyRequestAuth({headers:{authorization:`Bearer ${token}`}},db,{nowSeconds:NOW});
  assert.ok(payload);
  return {token,payload};
}

test('same-email recovery explicitly links Google to the existing account without moving membership or history',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'member@example.test'});
  await db.batch([
    `INSERT INTO circles (id,public_id,slug,name,is_primary) VALUES (1,'circle_primary','primary','Primary',1)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (1,1,'member','active')`,
    `INSERT INTO pairing_weeks (id,week_label,week_start,focus) VALUES (1,'2026-W38','2026-09-14','both')`,
    `INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (1,1,0,'auth')`,
  ],'write');
  const {payload}=await session(db,1,'member@example.test');
  const result=await linkGoogleCredential(db,payload,{
    issuer:GOOGLE_ISSUER,subject:'same-email-subject',providerEmail:'member@example.test',
    providerAuthenticatedAt:NOW,nowSeconds:NOW,
  });
  assert.equal(result.status,'linked');
  assert.deepEqual((await db.execute(`SELECT user_id FROM auth_provider_identities`)).rows,[{user_id:1}]);
  assert.deepEqual((await db.execute(`SELECT circle_id,user_id,status FROM circle_memberships`)).rows,
    [{circle_id:1,user_id:1,status:'active'}]);
  assert.deepEqual((await db.execute(`SELECT week_id,user_id,source FROM pairing_participants`)).rows,
    [{week_id:1,user_id:1,source:'auth'}]);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_accounts`)).rows[0].count),1);
  const audit=(await db.execute(`SELECT event_type,provider,outcome,reason_code FROM auth_identity_audit_events`)).rows;
  assert.deepEqual(audit,[{event_type:'recovery_completed',provider:'google',outcome:'succeeded',
    reason_code:'same_email_explicit_link'}]);
  assert.equal((await readIdentityState(db,payload,{nowSeconds:NOW})).recentAuth.method,'google');
  const persisted=JSON.stringify((await db.execute(`SELECT * FROM auth_provider_email_state`)).rows);
  assert.doesNotMatch(persisted,/member@example\.test/);
});

test('subject collisions fail closed, are audited, and never merge accounts',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'target@example.test'});
  await addAccount(db,{id:2,email:'provider@example.test',password:false,googleSubject:'occupied-subject'});
  const {payload}=await session(db,1,'target@example.test');
  const result=await linkGoogleCredential(db,payload,{
    issuer:GOOGLE_ISSUER,subject:'occupied-subject',providerEmail:'target@example.test',
    providerAuthenticatedAt:NOW,nowSeconds:NOW,
  });
  assert.equal(result.status,'provider_in_use');
  assert.deepEqual((await db.execute(`SELECT subject,user_id FROM auth_provider_identities`)).rows,
    [{subject:'occupied-subject',user_id:2}]);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_accounts`)).rows[0].count),2);
  assert.deepEqual((await db.execute(`SELECT user_id,event_type,outcome,reason_code FROM auth_identity_audit_events`)).rows,
    [{user_id:1,event_type:'link_conflict',outcome:'conflict',reason_code:'provider_in_use'}]);
});

test('concurrent attempts to link one subject converge on one account without duplicate identity',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'first@example.test'});
  await addAccount(db,{id:2,email:'second@example.test'});
  const first=await session(db,1,'first@example.test');
  const second=await session(db,2,'second@example.test');
  const secondClient=createClient({url:db.testDatabaseUrl});
  resources.push(()=>secondClient.close());
  const settled=await Promise.allSettled([
    linkGoogleCredential(db,first.payload,{issuer:GOOGLE_ISSUER,subject:'raced-subject',
      providerEmail:'first@example.test',providerAuthenticatedAt:NOW,nowSeconds:NOW}),
    linkGoogleCredential(secondClient,second.payload,{issuer:GOOGLE_ISSUER,subject:'raced-subject',
      providerEmail:'second@example.test',providerAuthenticatedAt:NOW,nowSeconds:NOW}),
  ]);
  assert.equal(settled.filter(item=>item.status==='fulfilled'&&item.value.status==='linked').length,1);
  const loser=settled.find(item=>item.status==='rejected'||item.value.status!=='linked');
  assert.ok(loser?.status==='rejected'
    ?String(loser.reason?.code||'').startsWith('SQLITE_BUSY')
    :loser?.value.status==='provider_in_use');
  assert.equal(Number((await db.execute({sql:`SELECT COUNT(*) AS count FROM auth_provider_identities
    WHERE issuer=? AND subject=?`,args:[GOOGLE_ISSUER,'raced-subject']})).rows[0].count),1);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_accounts`)).rows[0].count),2);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_accounts
    WHERE google_sub='raced-subject'`)).rows[0].count),1);
});

test('adding and unlinking credentials requires recent verified control and never removes the final method',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'google@example.test',password:false,googleSubject:'google-only-subject'});
  const googleSession=await session(db,1,'google@example.test','google');
  const denied=await unlinkGoogleCredential(db,googleSession.payload,{nowSeconds:NOW});
  assert.equal(denied.status,'final_credential');

  const passwordHash=await bcrypt.hash('new linked password',4);
  const added=await addPasswordCredential(db,googleSession.payload,{passwordHash,nowSeconds:NOW});
  assert.equal(added.status,'linked');
  assert.equal((await readIdentityState(db,googleSession.payload,{nowSeconds:NOW})).password.linked,true);

  const otherSession=await session(db,1,'google@example.test','password');
  const removedGoogle=await unlinkGoogleCredential(db,googleSession.payload,{nowSeconds:NOW});
  assert.equal(removedGoogle.status,'unlinked');
  assert.equal(await verifyRequestAuth({headers:{authorization:`Bearer ${otherSession.token}`}},db,{nowSeconds:NOW}),null);
  assert.ok(await verifyRequestAuth({headers:{authorization:`Bearer ${googleSession.token}`}},db,{nowSeconds:NOW}));

  const finalPassword=await unlinkPasswordCredential(db,googleSession.payload,{nowSeconds:NOW});
  assert.equal(finalPassword.status,'final_credential');
  const events=(await db.execute(`SELECT event_type,outcome,reason_code FROM auth_identity_audit_events ORDER BY id`)).rows;
  assert.deepEqual(events.map(row=>row.event_type),['unlink_denied','password_added','google_unlinked','unlink_denied']);
});

test('password unlink keeps Google, preserves the active session, and revokes other sessions',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'dual@example.test',googleSubject:'dual-subject'});
  const current=await session(db,1,'dual@example.test','google');
  const other=await session(db,1,'dual@example.test','password');
  const result=await unlinkPasswordCredential(db,current.payload,{nowSeconds:NOW});
  assert.equal(result.status,'unlinked');
  const account=(await db.execute(`SELECT password_hash,google_sub FROM auth_accounts WHERE id=1`)).rows[0];
  assert.equal(String(account.password_hash).startsWith('$2'),false);
  assert.equal(account.google_sub,'dual-subject');
  assert.ok(await verifyRequestAuth({headers:{authorization:`Bearer ${current.token}`}},db,{nowSeconds:NOW}));
  assert.equal(await verifyRequestAuth({headers:{authorization:`Bearer ${other.token}`}},db,{nowSeconds:NOW}),null);
});

test('stale recent auth blocks mutations before identity state changes',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'stale@example.test'});
  const stale=await session(db,1,'stale@example.test','password',NOW-601);
  await assert.rejects(linkGoogleCredential(db,stale.payload,{
    issuer:GOOGLE_ISSUER,subject:'fresh-provider',providerEmail:'stale@example.test',
    providerAuthenticatedAt:NOW,nowSeconds:NOW,
  }),error=>error?.code==='RECENT_AUTH_REQUIRED');
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_provider_identities`)).rows[0].count),0);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_identity_audit_events`)).rows[0].count),0);
});

test('provider email rotation is hash-only, audited once per change, and never rewrites the account email',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'canonical@example.test',password:true,googleSubject:'stable-subject'});
  assert.deepEqual(await observeGoogleProviderEmail(db,{
    issuer:GOOGLE_ISSUER,subject:'stable-subject',userId:1,providerEmail:'first@example.test',nowSeconds:NOW,
  }),{changed:false,rekeyed:false});
  assert.deepEqual(await observeGoogleProviderEmail(db,{
    issuer:GOOGLE_ISSUER,subject:'stable-subject',userId:1,providerEmail:'second@example.test',nowSeconds:NOW+1,
  }),{changed:true,rekeyed:false});
  assert.deepEqual(await observeGoogleProviderEmail(db,{
    issuer:GOOGLE_ISSUER,subject:'stable-subject',userId:1,providerEmail:'second@example.test',nowSeconds:NOW+2,
  }),{changed:false,rekeyed:false});
  assert.equal((await db.execute(`SELECT email FROM auth_accounts WHERE id=1`)).rows[0].email,'canonical@example.test');
  const observations=JSON.stringify((await db.execute(`SELECT * FROM auth_provider_email_state`)).rows);
  assert.doesNotMatch(observations,/first@example|second@example/);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_identity_audit_events
    WHERE event_type='provider_email_changed'`)).rows[0].count),1);

  process.env.IDENTITY_EMAIL_HASH_KEY=Buffer.alloc(32,8).toString('base64url');
  process.env.IDENTITY_EMAIL_HASH_KEY_VERSION='2';
  process.env.IDENTITY_EMAIL_HASH_PREVIOUS_KEYS=JSON.stringify([
    {version:1,key:Buffer.alloc(32,7).toString('base64url')},
  ]);
  await advanceCredentialKeyControl(db,identityEmailHashConfiguration(),{
    expectedVersion:1,expectedGeneration:1,
  });
  assert.deepEqual(await observeGoogleProviderEmail(db,{
    issuer:GOOGLE_ISSUER,subject:'stable-subject',userId:1,providerEmail:'second@example.test',nowSeconds:NOW+3,
  }),{changed:false,rekeyed:true});
  const state=(await db.execute(`SELECT hash_key_version,changed_at FROM auth_provider_email_state`)).rows[0];
  assert.equal(Number(state.hash_key_version),2);
  assert.equal(Number(state.changed_at),NOW+1);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_identity_audit_events
    WHERE event_type='provider_email_rekeyed' AND reason_code='hash_key_rotated'`)).rows[0].count),1);

  const beforeDowngrade=JSON.stringify((await db.execute(`SELECT * FROM auth_provider_email_state`)).rows);
  const auditBefore=Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_identity_audit_events`)).rows[0].count);
  process.env.IDENTITY_EMAIL_HASH_KEY=Buffer.alloc(32,9).toString('base64url');
  await assert.rejects(observeGoogleProviderEmail(db,{
    issuer:GOOGLE_ISSUER,subject:'stable-subject',userId:1,providerEmail:'second@example.test',nowSeconds:NOW+4,
  }),error=>error?.code==='KEY_CONTROL_SUBSTITUTION');
  process.env.IDENTITY_EMAIL_HASH_KEY=Buffer.alloc(32,7).toString('base64url');
  process.env.IDENTITY_EMAIL_HASH_KEY_VERSION='1';
  delete process.env.IDENTITY_EMAIL_HASH_PREVIOUS_KEYS;
  await assert.rejects(observeGoogleProviderEmail(db,{
    issuer:GOOGLE_ISSUER,subject:'stable-subject',userId:1,providerEmail:'third@example.test',nowSeconds:NOW+4,
  }),error=>error?.code==='KEY_CONTROL_DOWNGRADE');
  await addAccount(db,{id:2,email:'second-account@example.test'});
  const second=await session(db,2,'second-account@example.test','password');
  await assert.rejects(linkGoogleCredential(db,second.payload,{
    issuer:GOOGLE_ISSUER,subject:'new-subject-under-old-key',providerEmail:'second-account@example.test',
    providerAuthenticatedAt:NOW+4,nowSeconds:NOW+4,
  }),error=>error?.code==='KEY_CONTROL_DOWNGRADE');
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_provider_identities
    WHERE subject='new-subject-under-old-key'`)).rows[0].count),0);
  assert.equal(JSON.stringify((await db.execute(`SELECT * FROM auth_provider_email_state`)).rows),beforeDowngrade);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_identity_audit_events`)).rows[0].count),auditBefore);
});

test('identity rotation distinguishes changed mail with a prior key from neutral rebaseline without it',async()=>{
  const db=await fixture();
  await addAccount(db,{id:1,email:'canonical@example.test',password:true,googleSubject:'prior-key-subject'});
  await addAccount(db,{id:2,email:'second@example.test',password:true,googleSubject:'neutral-subject'});
  await observeGoogleProviderEmail(db,{issuer:GOOGLE_ISSUER,subject:'prior-key-subject',userId:1,
    providerEmail:'first@example.test',nowSeconds:NOW});
  await observeGoogleProviderEmail(db,{issuer:GOOGLE_ISSUER,subject:'neutral-subject',userId:2,
    providerEmail:'unchanged@example.test',nowSeconds:NOW});

  process.env.IDENTITY_EMAIL_HASH_KEY=Buffer.alloc(32,8).toString('base64url');
  process.env.IDENTITY_EMAIL_HASH_KEY_VERSION='2';
  process.env.IDENTITY_EMAIL_HASH_PREVIOUS_KEYS=JSON.stringify([
    {version:1,key:Buffer.alloc(32,7).toString('base64url')},
  ]);
  await advanceCredentialKeyControl(db,identityEmailHashConfiguration(),{
    expectedVersion:1,expectedGeneration:1,
  });
  assert.deepEqual(await observeGoogleProviderEmail(db,{issuer:GOOGLE_ISSUER,
    subject:'prior-key-subject',userId:1,providerEmail:'changed@example.test',nowSeconds:NOW+1}),
  {changed:true,rekeyed:true});
  const changedEvents=(await db.execute(`SELECT event_type FROM auth_identity_audit_events
    WHERE user_id=1 ORDER BY id`)).rows.map(row=>row.event_type);
  assert.deepEqual(changedEvents,['provider_email_changed','provider_email_rekeyed']);

  delete process.env.IDENTITY_EMAIL_HASH_PREVIOUS_KEYS;
  const missingPrior=await identityEmailKeyRotationStatus(db);
  assert.equal(missingPrior.ready,false);
  assert.equal(missingPrior.missing_key,1);
  assert.deepEqual(await observeGoogleProviderEmail(db,{issuer:GOOGLE_ISSUER,
    subject:'neutral-subject',userId:2,providerEmail:'genuinely-different@example.test',nowSeconds:NOW+2}),
  {changed:false,rekeyed:true});
  const neutralEvents=(await db.execute(`SELECT event_type FROM auth_identity_audit_events
    WHERE user_id=2 ORDER BY id`)).rows.map(row=>row.event_type);
  assert.deepEqual(neutralEvents,['provider_email_rekeyed']);
  const metrics=await identityEmailKeyRotationStatus(db);
  assert.equal(metrics.ready,true);
  assert.deepEqual(metrics.versions,{2:2});
  assert.doesNotMatch(JSON.stringify(metrics),/@example|first|changed|unchanged/);
});
