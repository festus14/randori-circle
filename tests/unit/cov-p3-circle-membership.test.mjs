import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import {
  acceptPreparedInvitation,
  circleMembershipCutoverStarted,
  circleMembershipRegistrationState,
  clearInviteClaimCookie,
  createGoogleAccountFromPreparedInvitation,
  createInvitationToken,
  createInviteClaim,
  createPasswordAccountFromPreparedInvitation,
  ensureCircleMembershipReadiness,
  getActivePrimaryCircleMembership,
  hasActiveCircleMembership,
  hashInvitationEmail,
  hashInvitationToken,
  inviteClaimCookie,
  inviteClaimRemainingSeconds,
  INVITE_CLAIM_COOKIE,
  INVITE_CLAIM_TTL_SECONDS,
  normalizeInvitationEmail,
  prepareInvitationClaim,
  readBoundInviteClaim,
  readInviteClaim,
  readInviteClaimForBindingHash,
  validateLivePreparedClaim,
  validatePreparedInvitation,
} from '../../api/_circle-membership.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const SECRET='cov-p3-circle-membership-secret-at-least-32-bytes';
const ENV_KEYS=['JWT_SECRET','TURSO_DATABASE_URL','CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED'];
const saved=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
const resources=[];
const INVITATION_ID='22222222-2222-4222-8222-222222222222';
const HASH_A='a'.repeat(64);
const HASH_B='b'.repeat(64);

beforeEach(()=>{
  process.env.JWT_SECRET=SECRET;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
  delete process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED;
});

afterEach(async()=>{
  for(const key of ENV_KEYS){
    if(saved[key]===undefined) delete process.env[key];
    else process.env[key]=saved[key];
  }
  while(resources.length){ try{ await resources.pop()(); }catch{} }
});

function sign(payload){
  return createHmac('sha256',SECRET).update(`randori-circle-invite-claim-v2\0${payload}`,'utf8').digest('base64url');
}

function signedCookie(value){
  const payload=Buffer.from(typeof value==='string'?value:JSON.stringify(value),'utf8').toString('base64url');
  return `${INVITE_CLAIM_COOKIE}=${payload}.${sign(payload)}`;
}

function claimBody(overrides={}){
  const now=Math.floor(Date.now()/1000);
  return {v:2,invitation_id:INVITATION_ID,circle_id:10,token_hash:HASH_A,email_hash:HASH_B,
    binding_hash:'c'.repeat(64),iat:now,exp:now+INVITE_CLAIM_TTL_SECONDS,...overrides};
}

function liveClaim(overrides={}){
  return {invitation_id:INVITATION_ID,circle_id:10,token_hash:HASH_A,email_hash:HASH_B,
    exp:Math.floor(Date.now()/1000)+60,...overrides};
}

async function migratedDb(){
  const {directory,url}=await createMigratedDatabase({prefix:'randori-cov-membership-',filename:'membership.sqlite'});
  const db=createClient({url});
  resources.push(async()=>{ try{ db.close(); }finally{ rmSync(directory,{recursive:true,force:true}); } });
  await prepareMigrationConnection(db);
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo)
      VALUES (1,'owner@example.test','!owner','Owner','#111111',1,0),
             (2,'member@example.test','!m','Member','#222222',0,0)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (10,'11111111-1111-4111-8111-111111111111','randori-circle','Primary',1,1,datetime('now')),
             (20,'33333333-3333-4333-8333-333333333333','secondary','Secondary',0,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (10,1,'owner','active',datetime('now'),datetime('now')),
             (20,2,'member','active',datetime('now'),datetime('now'))`,
  ],'write');
  return db;
}

test('email and token hashing normalize input and reject malformed values',()=>{
  assert.equal(normalizeInvitationEmail(42),null);
  assert.equal(normalizeInvitationEmail('   '),null);
  assert.equal(normalizeInvitationEmail(`${'a'.repeat(250)}@x.io`),null,'longer than 254');
  assert.equal(normalizeInvitationEmail('no-at-sign'),null);
  assert.equal(normalizeInvitationEmail(' User@Example.Test '),'user@example.test');
  assert.equal(hashInvitationToken(undefined),null);
  assert.equal(hashInvitationToken('short'),null);
  assert.equal(hashInvitationEmail('bad'),null);
  assert.equal(hashInvitationEmail('User@Example.test'),hashInvitationEmail('user@example.test'));
  const token=createInvitationToken();
  assert.match(hashInvitationToken(token),/^[0-9a-f]{64}$/);
  assert.notEqual(hashInvitationToken(token),hashInvitationEmail('user@example.test'));
});

test('claim creation rejects invalid fields and bindings',()=>{
  const fields={invitationId:INVITATION_ID,circleId:10,tokenHash:HASH_A,emailHash:HASH_B};
  for(const override of [{invitationId:'nope'},{invitationId:42},{circleId:0},{circleId:'010'},{circleId:1.5},
    {tokenHash:'x'},{emailHash:null}]){
    assert.throws(()=>createInviteClaim({...fields,...override}),/invalid invitation claim fields/,JSON.stringify(override));
  }
  assert.throws(()=>createInviteClaim(fields,{binding:'short'}),/invalid invitation claim binding/);
  assert.throws(()=>createInviteClaim(fields,{binding:42}),/invalid invitation claim binding/);
  const claim=createInviteClaim({...fields,circleId:'10',invitationId:INVITATION_ID.toUpperCase()});
  const parsed=readInviteClaim({headers:{Cookie:`other=1; ${INVITE_CLAIM_COOKIE}=${encodeURIComponent(claim)}`}});
  assert.equal(parsed.invitation_id,INVITATION_ID,'ids are normalized to lower case');
  assert.equal(parsed.circle_id,10);
  assert.equal(parsed.exp-parsed.iat,INVITE_CLAIM_TTL_SECONDS);
});

test('claim cookies fail closed for missing, forged, malformed, stale, and future claims',()=>{
  const read=cookie=>readInviteClaim({headers:{cookie}});
  assert.equal(readInviteClaim({}),null);
  assert.equal(readInviteClaim(null),null);
  assert.equal(read('=orphan; noequals'),null);
  assert.equal(read(`${INVITE_CLAIM_COOKIE}=%E0%A4%A`),null,'undecodable cookie');
  assert.equal(read(`${INVITE_CLAIM_COOKIE}=abc.${'x'.repeat(43)}`),null,'forged signature');
  assert.equal(read(signedCookie('not json')),null);
  assert.equal(read(signedCookie('[1,2]')),null);
  assert.equal(read(signedCookie('null')),null);
  assert.equal(read(signedCookie({...claimBody(),extra:1})),null,'unexpected keys');
  const {binding_hash:_,...missing}=claimBody();
  assert.equal(read(signedCookie({...missing,other:1})),null,'renamed key');
  const now=Math.floor(Date.now()/1000);
  for(const override of [{v:1},{invitation_id:'nope'},{circle_id:-1},{token_hash:'x'},{email_hash:'x'},
    {binding_hash:'x'},{iat:'1'},{exp:1.5},{iat:now+120,exp:now+120+INVITE_CLAIM_TTL_SECONDS},
    {iat:now-INVITE_CLAIM_TTL_SECONDS-1,exp:now-1},{exp:now+INVITE_CLAIM_TTL_SECONDS+5}]){
    assert.equal(read(signedCookie(claimBody(override))),null,JSON.stringify(override));
  }
  assert.equal(read(signedCookie(claimBody())).circle_id,10);
});

test('binding-aware claim reads require the exact binding and expose remaining lifetime',()=>{
  const binding='B'.repeat(43);
  const claim=createInviteClaim({invitationId:INVITATION_ID,circleId:10,tokenHash:HASH_A,emailHash:HASH_B},{binding});
  const req={headers:{cookie:`${INVITE_CLAIM_COOKIE}=${claim}`}};
  assert.equal(readBoundInviteClaim(req,binding).invitation_id,INVITATION_ID);
  assert.equal(readBoundInviteClaim(req,'C'.repeat(43)),null,'different binding');
  assert.equal(readBoundInviteClaim(req,'bad binding'),null);
  assert.equal(readBoundInviteClaim(req,null),null);
  assert.equal(readInviteClaimForBindingHash(req,'not-a-hash'),null);
  assert.equal(readInviteClaimForBindingHash(req,HASH_A),null);
  assert.equal(readInviteClaimForBindingHash({headers:{}},HASH_A),null);

  const parsed=readInviteClaim(req);
  assert.equal(inviteClaimRemainingSeconds(parsed,{nowSeconds:parsed.exp-5}),5);
  assert.equal(inviteClaimRemainingSeconds(parsed,{nowSeconds:parsed.exp+5}),0);
  assert.equal(inviteClaimRemainingSeconds(null),0);
  assert.equal(inviteClaimRemainingSeconds({exp:'soon'}),0);
  assert.throws(()=>inviteClaimRemainingSeconds(parsed,{nowSeconds:0}),/valid claim time/);
  assert.throws(()=>inviteClaimRemainingSeconds(parsed,{nowSeconds:1.5}),/valid claim time/);

  assert.equal(inviteClaimCookie('a b',{secure:false}),
    `${INVITE_CLAIM_COOKIE}=a%20b; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${INVITE_CLAIM_TTL_SECONDS}`);
  assert.match(inviteClaimCookie('x'),/HttpOnly; Secure; SameSite=Lax/);
  assert.equal(clearInviteClaimCookie(),`${INVITE_CLAIM_COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  assert.equal(clearInviteClaimCookie({secure:false}),`${INVITE_CLAIM_COOKIE}=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0`);
});

test('readiness requires a client, caches per URL, evicts failures, and probes the context table when enabled',async()=>{
  await assert.rejects(()=>ensureCircleMembershipReadiness(null),/database client is required/);
  const statements=[];
  let fail=true;
  const db={async execute(sql){
    statements.push(sql);
    if(fail) throw new Error('no such table');
    return {rows:[]};
  }};
  process.env.TURSO_DATABASE_URL='libsql://cov-p3-membership.example';
  await assert.rejects(()=>ensureCircleMembershipReadiness(db),/no such table/);
  fail=false;
  statements.length=0;
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  await ensureCircleMembershipReadiness(db);
  assert.equal(statements.length,7,'failed probe was evicted and retried, including the context table');
  assert.ok(statements.some(sql=>sql.includes('auth_session_circle_contexts')));
  // A second client on the same URL reuses the cached readiness.
  const other={execute:async()=>assert.fail('cached readiness must not re-probe')};
  await ensureCircleMembershipReadiness(other);
});

test('membership lookups validate user ids and honour archive and status',async()=>{
  const db=await migratedDb();
  assert.equal(await getActivePrimaryCircleMembership(db,'abc'),null);
  assert.equal(await getActivePrimaryCircleMembership(db,0),null);
  assert.equal((await getActivePrimaryCircleMembership(db,'1')).role,'owner');
  assert.equal(await getActivePrimaryCircleMembership(db,2),null,'secondary-only member has no primary membership');
  assert.equal(await hasActiveCircleMembership(db,-3),false);
  assert.equal(await hasActiveCircleMembership(db,2),true);
  await db.execute(`UPDATE circles SET archived_at=datetime('now') WHERE id=20`);
  assert.equal(await hasActiveCircleMembership(db,2),false,'archived circles do not count');
  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE user_id=1`);
  assert.equal(await hasActiveCircleMembership(db,1),false);
});

test('registration state reports uninitialized, open, and closed rollout',async()=>{
  await assert.rejects(()=>circleMembershipRegistrationState(undefined),/database client is required/);
  const states=[{rows:[]}];
  const scripted={async execute(){ return states.shift(); }};
  assert.equal(await circleMembershipRegistrationState(scripted),'uninitialized');
  states.push({rows:[{present:1}]},{rows:[{registrations_closed:0}]});
  assert.equal(await circleMembershipRegistrationState(scripted),'open');
  states.push({rows:[{present:1}]},{rows:[]});
  assert.equal(await circleMembershipCutoverStarted(scripted),true,'a missing singleton is treated as closed');
  states.push({rows:[{present:1}]},{rows:[{registrations_closed:1}]});
  assert.equal(await circleMembershipRegistrationState(scripted),'closed');
});

test('prepare and validation reject malformed tokens, claims, rows, and mismatched email',async()=>{
  const never={execute:async()=>assert.fail('must not query for malformed input')};
  assert.deepEqual(await prepareInvitationClaim(never,{token:'bad'}),{ok:false});
  const token=createInvitationToken();
  assert.deepEqual(await prepareInvitationClaim({execute:async()=>({rows:[]})},{token}),{ok:false});
  assert.deepEqual(await prepareInvitationClaim({execute:async()=>({rows:[{id:'bad',circle_id:10,email_hash:HASH_B}]})},
    {token}),{ok:false},'corrupt stored row');
  const prepared=await prepareInvitationClaim({execute:async()=>({rows:[{id:INVITATION_ID,circle_id:'10',
    email_hash:HASH_B,expires_at:'2099-01-01'}]})},{token});
  assert.equal(prepared.ok,true);
  assert.equal(prepared.circle_id,10);
  assert.equal(prepared.claim.includes(token),false,'raw token never enters the claim');

  for(const claim of [null,[],liveClaim({exp:1}),liveClaim({exp:'x'}),liveClaim({invitation_id:'x'}),
    liveClaim({circle_id:0}),liveClaim({token_hash:'x'}),liveClaim({email_hash:'x'})]){
    assert.deepEqual(await validateLivePreparedClaim(never,{claim}),{ok:false});
  }
  assert.deepEqual(await validateLivePreparedClaim({execute:async()=>({rows:[]})},{claim:liveClaim()}),{ok:false});

  const emailHash=hashInvitationEmail('invitee@example.test');
  assert.deepEqual(await validatePreparedInvitation(never,{claim:liveClaim({email_hash:emailHash}),email:'other@example.test'}),
    {ok:false},'email mismatch');
  assert.deepEqual(await validatePreparedInvitation(never,{claim:liveClaim(),email:'bad'}),{ok:false});
  assert.deepEqual(await validatePreparedInvitation({execute:async()=>({rows:[]})},
    {claim:liveClaim({email_hash:emailHash}),email:'invitee@example.test'}),{ok:false});
  assert.deepEqual(await validatePreparedInvitation({execute:async()=>({rows:[{id:INVITATION_ID,circle_id:10,used_by:null}]})},
    {claim:liveClaim({email_hash:emailHash}),email:'Invitee@example.test'}),
  {ok:true,circle_id:10,invitation_id:INVITATION_ID,email_hash:emailHash,used_by:null});
  assert.equal((await validatePreparedInvitation({execute:async()=>({rows:[{id:INVITATION_ID,circle_id:10,used_by:'7'}]})},
    {claim:liveClaim({email_hash:emailHash}),email:'invitee@example.test'})).used_by,7);

  const neverBatch={batch:async()=>assert.fail('must not write')};
  assert.deepEqual(await acceptPreparedInvitation(neverBatch,{claim:liveClaim({email_hash:emailHash}),
    email:'invitee@example.test',userId:'x'}),{ok:false});
  assert.deepEqual(await acceptPreparedInvitation(neverBatch,{claim:liveClaim(),email:'invitee@example.test',userId:1}),
    {ok:false},'email hash mismatch');
  const batch=results=>({batch:async()=>results});
  assert.deepEqual(await acceptPreparedInvitation(batch([{rows:[]},{rows:[]},{rows:[]}]),
    {claim:liveClaim({email_hash:emailHash}),email:'invitee@example.test',userId:5}),{ok:false});
  assert.deepEqual(await acceptPreparedInvitation(batch([{rows:[{circle_id:10,used_by:6}]},{rows:[{status:'active'}]},{rows:[]}]),
    {claim:liveClaim({email_hash:emailHash}),email:'invitee@example.test',userId:5}),{ok:false},'used by another user');
  assert.deepEqual(await acceptPreparedInvitation(batch([{rows:[{circle_id:10,used_by:5}]},{rows:[{status:'removed'}]},{rows:[]}]),
    {claim:liveClaim({email_hash:emailHash}),email:'invitee@example.test',userId:5}),{ok:false},'inactive membership');
  assert.deepEqual(await acceptPreparedInvitation(batch([{rows:[{circle_id:10,used_by:5}]},{rows:[{status:'active'}]},{rows:[]}]),
    {claim:liveClaim({email_hash:emailHash}),email:'invitee@example.test',userId:5}),{ok:true,circle_id:10,idempotent:true});
});

function scriptedTransaction(steps){
  const log=[];
  const transaction={
    async execute(){
      const next=steps.shift();
      log.push('execute');
      if(next instanceof Error) throw next;
      return next;
    },
    async rollback(){ log.push('rollback'); if(transaction.rollbackFails) throw new Error('rollback failed'); },
    async commit(){ log.push('commit'); },
  };
  return {db:{transaction:async()=>transaction},log,transaction};
}

const EMAIL='invitee@example.test';
const googleInput=()=>({claim:liveClaim({email_hash:hashInvitationEmail(EMAIL)}),email:EMAIL,
  passwordHash:'!oauth:google',displayName:' Invitee ',color:'#123456',
  googleIssuer:'https://accounts.google.com',googleSub:'sub_123'});
const passwordInput=()=>({claim:liveClaim({email_hash:hashInvitationEmail(EMAIL)}),email:EMAIL,
  passwordHash:'$2b$10$abcdefghijklmnopqrstuv',displayName:'Invitee',color:'#123456'});

test('Google invitation account creation validates every input before opening a transaction',async()=>{
  const never={transaction:async()=>assert.fail('must not open a transaction')};
  for(const override of [{claim:null},{email:'bad'},{email:'other@example.test'},{passwordHash:'$2b$plain'},
    {passwordHash:`!oauth:${'x'.repeat(130)}`},{displayName:'   '},{displayName:7},{color:'x'.repeat(33)},
    {googleIssuer:'https://evil.example'},{googleSub:'has space'},{googleSub:''}]){
    assert.deepEqual(await createGoogleAccountFromPreparedInvitation(never,{...googleInput(),...override}),{ok:false},
      JSON.stringify(override).slice(0,60));
  }
});

test('Google invitation account creation rolls back at each failed guarded step',async()=>{
  const created={rows:[{id:9,is_admin:0}]};
  const identity={rows:[{user_id:9}]};
  const accepted={rows:[{circle_id:10,used_by:9}]};
  const member={rows:[{circle_id:10,user_id:9,role:'member',status:'active'}]};
  const scenarios=[
    [{rows:[]}],
    [{rows:[{id:'zero',is_admin:0}]}],
    [created,{rows:[]}],
    [created,{rows:[{user_id:8}]}],
    [created,identity,{rows:[]}],
    [created,identity,{rows:[{circle_id:10,used_by:8}]}],
    [created,identity,{rows:[{circle_id:11,used_by:9}]}],
    [created,identity,accepted,{rows:[]}],
    [created,identity,accepted,{rows:[{circle_id:10,user_id:8,status:'active'}]}],
    [created,identity,accepted,{rows:[{circle_id:11,user_id:9,status:'active'}]}],
    [created,identity,accepted,{rows:[{circle_id:10,user_id:9,status:'removed'}]}],
    [created,identity,accepted,member,{rows:[]}],
  ];
  for(const [index,steps] of scenarios.entries()){
    const {db,log}=scriptedTransaction([...steps]);
    assert.deepEqual(await createGoogleAccountFromPreparedInvitation(db,googleInput()),{ok:false},`scenario ${index}`);
    assert.equal(log.at(-1),'rollback',`scenario ${index} rolls back`);
    assert.equal(log.includes('commit'),false);
  }
  const ok=scriptedTransaction([{rows:[{id:9,is_admin:1}]},identity,accepted,member,{rows:[{id:1}]}]);
  assert.deepEqual(await createGoogleAccountFromPreparedInvitation(ok.db,{...googleInput(),isAdmin:true}),
    {ok:true,user_id:9,is_admin:true,circle_id:10,created:true,idempotent:false});
  assert.equal(ok.log.at(-1),'commit');

  const failing=scriptedTransaction([created,new Error('SQLITE_IOERR')]);
  failing.transaction.rollbackFails=true;
  await assert.rejects(()=>createGoogleAccountFromPreparedInvitation(failing.db,googleInput()),/SQLITE_IOERR/,
    'the original error survives a failed rollback');
  assert.equal(failing.log.at(-1),'rollback');
});

test('password invitation account creation validates input and rolls back at each failed step',async()=>{
  const never={transaction:async()=>assert.fail('must not open a transaction')};
  for(const override of [{claim:liveClaim({exp:1})},{email:'nope'},{passwordHash:'!oauth:x'},
    {passwordHash:`$2${'x'.repeat(130)}`},{displayName:''},{color:null}]){
    assert.deepEqual(await createPasswordAccountFromPreparedInvitation(never,{...passwordInput(),...override}),{ok:false});
  }
  const created={rows:[{id:9,is_admin:0}]};
  const accepted={rows:[{circle_id:10,used_by:9}]};
  const member={rows:[{circle_id:10,user_id:9,role:'member',status:'active'}]};
  const scenarios=[
    [{rows:[]}],
    [{rows:[{id:null}]}],
    [created,{rows:[]}],
    [created,{rows:[{circle_id:10,used_by:3}]}],
    [created,{rows:[{circle_id:12,used_by:9}]}],
    [created,accepted,{rows:[]}],
    [created,accepted,{rows:[{circle_id:10,user_id:3,status:'active'}]}],
    [created,accepted,{rows:[{circle_id:12,user_id:9,status:'active'}]}],
    [created,accepted,{rows:[{circle_id:10,user_id:9,status:'pending'}]}],
    [created,accepted,member,{rows:[]}],
  ];
  for(const [index,steps] of scenarios.entries()){
    const {db,log}=scriptedTransaction([...steps]);
    assert.deepEqual(await createPasswordAccountFromPreparedInvitation(db,passwordInput()),{ok:false},`scenario ${index}`);
    assert.equal(log.at(-1),'rollback');
  }
  const ok=scriptedTransaction([created,accepted,member,{rows:[{id:1}]}]);
  assert.deepEqual(await createPasswordAccountFromPreparedInvitation(ok.db,passwordInput()),
    {ok:true,user_id:9,is_admin:false,circle_id:10,created:true,idempotent:false});
  const failing=scriptedTransaction([new Error('disk full')]);
  failing.transaction.rollbackFails=true;
  await assert.rejects(()=>createPasswordAccountFromPreparedInvitation(failing.db,passwordInput()),/disk full/);
});

test('secondary-circle invitations are preparable only with the multi-circle control plane',async()=>{
  const db=await migratedDb();
  const token=createInvitationToken();
  await db.execute({sql:`INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
    VALUES (?,20,?,?,1,datetime('now'),datetime('now','+1 day'))`,
  args:[INVITATION_ID,hashInvitationToken(token),hashInvitationEmail(EMAIL)]});
  assert.deepEqual(await prepareInvitationClaim(db,{token}),{ok:false},'legacy mode is primary-only');
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  const prepared=await prepareInvitationClaim(db,{token});
  assert.equal(prepared.ok,true);
  assert.equal(prepared.circle_id,20);
  const claim=liveClaim({circle_id:20,token_hash:hashInvitationToken(token),email_hash:hashInvitationEmail(EMAIL)});
  assert.equal((await validateLivePreparedClaim(db,{claim})).ok,true);
  await db.execute(`UPDATE circles SET archived_at=datetime('now') WHERE id=20`);
  assert.deepEqual(await validateLivePreparedClaim(db,{claim}),{ok:false},'archived circles are not joinable');
});
