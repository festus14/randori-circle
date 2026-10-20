import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  changeAppAdmin,
  changeCircleOwnerRole,
  listCircleMembersForOwner,
} from '../../api/_member-lifecycle.js';
import { issueSession, verifyRequestAuth } from '../../api/_db.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const JWT_SECRET='co-owner-admin-test-secret-at-least-thirty-two-bytes';
const NOW=Math.floor(Date.now()/1000);
const originalSecret=process.env.JWT_SECRET;
const resources=[];

afterEach(async()=>{
  while(resources.length){
    try{ await resources.pop()(); }catch{}
  }
  if(originalSecret===undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=originalSecret;
});

// Circle 10 (primary): 1 owner+admin, 2 member, 3 owner (inactive), 5 member,
// 6 member (inactive), 7 demo member. Circle 20 (secondary): 4 owner, 1 member.
async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-co-owner-'));
  const url=`file:${join(directory,'database.sqlite')}`;
  const db=createClient({url});
  resources.push(async()=>{ await db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db,{migrations:EXECUTABLE_MIGRATIONS});
  await applyMigrations(db,{migrations:EXECUTABLE_MIGRATIONS,expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY});
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo) VALUES
      (1,'owner@example.test','x','Owner','#112233',1,0),
      (2,'member@example.test','x','Member','#445566',0,0),
      (3,'owner-two@example.test','x','Owner Two','#778899',0,0),
      (4,'outsider@example.test','x','Outsider','#aabbcc',0,0),
      (5,'member-two@example.test','x','Member Two','#ccbbaa',0,0),
      (6,'inactive@example.test','x','Inactive','#ddeeff',0,0),
      (7,'demo@example.test','x','Demo','#ffeedd',0,1)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES
      (10,'circle-primary','randori-circle','Primary',1,1),
      (20,'circle-other','other-circle','Other',0,4)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES
      (10,1,'owner','active'),(10,2,'member','active'),(10,3,'owner','inactive'),
      (10,5,'member','active'),(10,6,'member','inactive'),(10,7,'member','active'),
      (20,4,'owner','active'),(20,1,'member','active')`,
  ],'write');
  process.env.JWT_SECRET=JWT_SECRET;
  return {db,url};
}

async function connect(url){
  const client=createClient({url});
  resources.push(async()=>{ await client.close(); });
  await prepareMigrationConnection(client);
  return client;
}

const EMAILS=Object.freeze({1:'owner@example.test',2:'member@example.test',3:'owner-two@example.test',5:'member-two@example.test'});

async function recentSession(db,id,{authenticatedAt=NOW}={}){
  const token=await issueSession(db,{id,email:EMAILS[id],name:`User ${id}`},{
    recentAuthMethod:'password',nowSeconds:authenticatedAt,
  });
  return verifyRequestAuth({headers:{cookie:`randori_session=${encodeURIComponent(token)}`}},db,{nowSeconds:NOW});
}

async function roles(db,circleId=10){
  const result=await db.execute({sql:`SELECT user_id,role,status FROM circle_memberships WHERE circle_id=? ORDER BY user_id`,args:[circleId]});
  return Object.fromEntries(result.rows.map(row=>[Number(row.user_id),`${row.role}/${row.status}`]));
}

async function admins(db){
  const result=await db.execute(`SELECT id FROM auth_accounts WHERE is_admin=1 ORDER BY id`);
  return result.rows.map(row=>Number(row.id));
}

async function audits(db){
  const result=await db.execute(`SELECT circle_id,event_type,actor_user_id,subject_user_id FROM circle_audit_events ORDER BY id`);
  return result.rows.map(row=>[Number(row.circle_id),row.event_type,Number(row.actor_user_id),Number(row.subject_user_id)]);
}

async function liveSessions(db,userId){
  const result=await db.execute({sql:`SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL`,args:[userId]});
  return Number(result.rows[0].count);
}

function role(db,actor,target,action,session,extra={}){
  return changeCircleOwnerRole(db,{actorUserId:actor,targetUserId:target,circleId:10,action,session,nowSeconds:NOW,...extra});
}

function admin(db,actor,target,action,session,extra={}){
  return changeAppAdmin(db,{actorUserId:actor,targetUserId:target,circleId:10,action,session,nowSeconds:NOW,...extra});
}

test('an owner adds a co-owner without demoting themselves, audited, with sessions untouched',async()=>{
  const {db}=await fixture();
  await issueSession(db,{id:2,email:'member@example.test',name:'Member'});
  const sessionsBefore=await liveSessions(db,2);
  const session=await recentSession(db,1);
  assert.deepEqual(await role(db,1,2,'make_owner',session),{ok:true,member:{id:2,role:'owner',status:'active'}});
  assert.equal((await roles(db))[1],'owner/active','the actor stays an owner');
  assert.equal((await roles(db))[2],'owner/active');
  assert.deepEqual(await audits(db),[[10,'ownership.granted',1,2]]);
  assert.equal(await liveSessions(db,2),sessionsBefore,'role changes never revoke sessions');

  // The new co-owner has full owner authority immediately (read from the DB).
  const roster=await listCircleMembersForOwner(db,{actorUserId:2,circleId:10,cursorSecret:JWT_SECRET});
  assert.equal(roster.ok,true);
  assert.deepEqual(roster.members.map(member=>[member.id,member.role,member.is_admin]),[
    [1,'owner',true],[2,'owner',false],[3,'owner',false],[5,'member',false],[6,'member',false],
  ]);

  // Replays and invalid transitions are explicit conflicts, never silent writes.
  assert.deepEqual(await role(db,1,2,'make_owner',session),{ok:false,reason:'state_conflict'});
  assert.deepEqual(await role(db,1,1,'make_owner',session),{ok:false,reason:'self_role_change'});
  assert.deepEqual(await role(db,1,6,'make_owner',session),{ok:false,reason:'state_conflict'},'inactive target');
  assert.deepEqual(await role(db,1,4,'make_owner',session),{ok:false,reason:'not_found'},'cross-circle target');
  assert.deepEqual(await role(db,1,999,'make_owner',session),{ok:false,reason:'not_found'},'missing target');
  const memberSession=await recentSession(db,5);
  assert.deepEqual(await role(db,5,2,'remove_owner',memberSession),{ok:false,reason:'not_found'},'non-owner actor');
  assert.equal((await audits(db)).length,1);
  await assert.rejects(role(db,1,2,'unknown',session),TypeError);
});

test('an owner removes another owner role while at least one active owner remains',async()=>{
  const {db}=await fixture();
  const session=await recentSession(db,1);
  await role(db,1,2,'make_owner',session);
  assert.deepEqual(await role(db,1,2,'remove_owner',session),{ok:true,member:{id:2,role:'member',status:'active'}});
  assert.deepEqual(await role(db,1,3,'remove_owner',session),{ok:true,member:{id:3,role:'member',status:'inactive'}},
    'an inactive owner can be demoted');
  assert.deepEqual(await role(db,1,2,'remove_owner',session),{ok:false,reason:'state_conflict'},'already a member');
  assert.deepEqual(await role(db,1,1,'remove_owner',session),{ok:false,reason:'self_role_change'});
  assert.deepEqual(await audits(db),[
    [10,'ownership.granted',1,2],[10,'ownership.revoked',1,2],[10,'ownership.revoked',1,3],
  ]);
  const remaining=await roles(db);
  assert.equal(remaining[1],'owner/active');
});

test('owner role changes require fresh proof for the acting session and change nothing otherwise',async()=>{
  const {db}=await fixture();
  const before=await roles(db);
  await assert.rejects(role(db,1,2,'make_owner',null),error=>error?.code==='RECENT_AUTH_REQUIRED');
  const stale=await recentSession(db,1,{authenticatedAt:NOW-601});
  await assert.rejects(role(db,1,2,'make_owner',stale),error=>error?.code==='RECENT_AUTH_REQUIRED');
  const otherAccount=await recentSession(db,2);
  await assert.rejects(role(db,1,2,'make_owner',otherAccount),error=>error?.code==='RECENT_AUTH_REQUIRED');
  await assert.rejects(role(db,1,3,'remove_owner',stale),error=>error?.code==='RECENT_AUTH_REQUIRED');
  assert.deepEqual(await roles(db),before);
  assert.deepEqual(await audits(db),[]);
});

test('three owners can each act and each be demoted while one active owner remains',async()=>{
  const {db}=await fixture();
  const one=await recentSession(db,1);
  await role(db,1,2,'make_owner',one);
  const two=await recentSession(db,2);
  assert.equal((await role(db,2,5,'make_owner',two)).ok,true,'a co-owner can add more owners');
  const five=await recentSession(db,5);
  assert.equal((await role(db,5,1,'remove_owner',five)).ok,true,'any owner can demote the original owner');
  assert.equal((await role(db,2,5,'remove_owner',two)).ok,true);
  const current=await roles(db);
  assert.deepEqual([current[1],current[2],current[5]],['member/active','owner/active','member/active']);
  // Owner 2 is now the only active owner; nobody else holds authority to demote them.
  assert.deepEqual(await role(db,5,2,'remove_owner',five),{ok:false,reason:'not_found'});
  assert.deepEqual(await role(db,1,2,'remove_owner',one),{ok:false,reason:'not_found'});
});

test('concurrent mutual demotions by several owners never leave the circle without an active owner',async()=>{
  const {db,url}=await fixture();
  const one=await recentSession(db,1);
  await role(db,1,2,'make_owner',one);
  await role(db,1,5,'make_owner',one);
  const clients=[db,await connect(url),await connect(url)];
  const sessions=[one,await recentSession(db,2),await recentSession(db,5)];
  const ids=[1,2,5];
  // Each owner demotes the next one in a ring, and the first pair also demotes each other.
  const attempts=[
    [0,1],[1,2],[2,0],[1,0],
  ].map(([actor,target])=>role(clients[actor],ids[actor],ids[target],'remove_owner',sessions[actor]));
  const outcomes=await Promise.allSettled(attempts);
  for(const outcome of outcomes){
    if(outcome.status==='rejected') assert.match(String(outcome.reason?.code||outcome.reason?.message),/SQLITE_BUSY|database is locked/i);
  }
  const owners=await db.execute(`SELECT COUNT(*) AS count FROM circle_memberships
    WHERE circle_id=10 AND role='owner' AND status='active'`);
  assert.ok(Number(owners.rows[0].count)>=1,'at least one active owner always remains');
  const succeeded=outcomes.filter(outcome=>outcome.status==='fulfilled'&&outcome.value.ok).length;
  const revoked=(await audits(db)).filter(row=>row[1]==='ownership.revoked').length;
  assert.equal(revoked,succeeded,'one audit row per committed demotion');
});

test('a stale circle context is rejected before any owner or admin write',async()=>{
  const {db}=await fixture();
  const session=await recentSession(db,1);
  const circleContext={payload:session,contextVersion:999,implicit:false};
  assert.deepEqual(await role(db,1,2,'make_owner',session,{circleContext}),{ok:false,reason:'context_changed'});
  assert.deepEqual(await admin(db,1,2,'grant_admin',session,{circleContext}),{ok:false,reason:'context_changed'});
  assert.deepEqual(await audits(db),[]);
});

test('an admin grants and revokes app admin for primary-circle members with audit and no session churn',async()=>{
  const {db}=await fixture();
  await issueSession(db,{id:2,email:'member@example.test',name:'Member'});
  const sessionsBefore=await liveSessions(db,2);
  const session=await recentSession(db,1);
  assert.deepEqual(await admin(db,1,2,'grant_admin',session),{ok:true,member:{id:2,status:'active',is_admin:true}});
  assert.deepEqual(await admins(db),[1,2]);
  assert.deepEqual(await admin(db,1,2,'grant_admin',session),{ok:false,reason:'state_conflict'},'replay');
  assert.deepEqual(await admin(db,1,2,'revoke_admin',session),{ok:true,member:{id:2,status:'active',is_admin:false}});
  assert.deepEqual(await admins(db),[1]);
  assert.deepEqual(await audits(db),[[10,'admin.granted',1,2],[10,'admin.revoked',1,2]]);
  assert.equal(await liveSessions(db,2),sessionsBefore);
  assert.deepEqual(await admin(db,1,2,'revoke_admin',session),{ok:false,reason:'state_conflict'},'already revoked');
  await assert.rejects(admin(db,1,2,'unknown',session),TypeError);
});

test('admin changes are scoped to an active non-demo admin in the primary circle',async()=>{
  const {db}=await fixture();
  const session=await recentSession(db,1);
  assert.deepEqual(await admin(db,1,4,'grant_admin',session),{ok:false,reason:'not_found'},'cross-circle target');
  assert.deepEqual(await admin(db,1,999,'grant_admin',session),{ok:false,reason:'not_found'},'missing target');
  assert.deepEqual(await admin(db,1,7,'grant_admin',session),{ok:false,reason:'not_found'},'demo target');
  assert.deepEqual(await admin(db,1,6,'grant_admin',session),{ok:false,reason:'state_conflict'},'inactive target');
  const ownerSession=await recentSession(db,3);
  await db.execute(`UPDATE circle_memberships SET status='active' WHERE circle_id=10 AND user_id=3`);
  assert.deepEqual(await admin(db,3,2,'grant_admin',ownerSession),{ok:false,reason:'admin_required'},'owners are not automatically admins');
  assert.deepEqual(await changeAppAdmin(db,{actorUserId:1,targetUserId:4,circleId:20,action:'grant_admin',session,nowSeconds:NOW}),
    {ok:false,reason:'admin_required'},'admin authority is exercised from the primary circle only');
  await db.execute(`UPDATE auth_accounts SET is_demo=1 WHERE id=1`);
  assert.deepEqual(await admin(db,1,2,'grant_admin',session),{ok:false,reason:'admin_required'},'demo admins cannot act');
  await db.execute(`UPDATE auth_accounts SET is_demo=0 WHERE id=1`);
  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=10 AND user_id=1`);
  assert.deepEqual(await admin(db,1,2,'grant_admin',session),{ok:false,reason:'admin_required'},'inactive admins cannot act');
  assert.deepEqual(await audits(db),[]);
  assert.deepEqual(await admins(db),[1]);
});

test('admin changes require recent auth and keep the last active admin and configured admins',async()=>{
  const {db}=await fixture();
  await assert.rejects(admin(db,1,2,'grant_admin',null),error=>error?.code==='RECENT_AUTH_REQUIRED');
  const stale=await recentSession(db,1,{authenticatedAt:NOW-601});
  await assert.rejects(admin(db,1,2,'grant_admin',stale),error=>error?.code==='RECENT_AUTH_REQUIRED');
  assert.deepEqual(await admins(db),[1]);

  const session=await recentSession(db,1);
  assert.deepEqual(await admin(db,1,1,'revoke_admin',session),{ok:false,reason:'last_admin'});
  await admin(db,1,2,'grant_admin',session);
  // An admin whose only membership is inactive does not count as an active admin.
  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=10 AND user_id=2`);
  assert.deepEqual(await admin(db,1,1,'revoke_admin',session),{ok:false,reason:'last_admin'});
  assert.equal((await admin(db,1,2,'revoke_admin',session)).ok,true,'an inactive member can still lose admin');
  await db.execute(`UPDATE circle_memberships SET status='active' WHERE circle_id=10 AND user_id=2`);
  await admin(db,1,2,'grant_admin',session);
  assert.deepEqual(await admin(db,1,2,'revoke_admin',session,{adminEmails:[' Member@Example.test ']}),
    {ok:false,reason:'configured_admin'},'ADMIN_EMAILS would re-grant on next sign-in');
  assert.equal((await admin(db,1,1,'revoke_admin',session)).ok,true,'self-revoke works when another admin remains');
  assert.deepEqual(await admins(db),[2]);
});

test('three admins can each grant and revoke, and concurrent revocations always keep one admin',async()=>{
  const {db,url}=await fixture();
  const one=await recentSession(db,1);
  await admin(db,1,2,'grant_admin',one);
  const two=await recentSession(db,2);
  assert.equal((await admin(db,2,5,'grant_admin',two)).ok,true,'a granted admin can grant');
  assert.deepEqual(await admins(db),[1,2,5]);
  const five=await recentSession(db,5);
  const clients=[db,await connect(url),await connect(url)];
  const sessions=[one,two,five];
  const ids=[1,2,5];
  const outcomes=await Promise.allSettled([
    [0,1],[1,2],[2,0],[0,0],[1,1],[2,2],
  ].map(([actor,target])=>admin(clients[actor],ids[actor],ids[target],'revoke_admin',sessions[actor])));
  for(const outcome of outcomes){
    if(outcome.status==='rejected') assert.match(String(outcome.reason?.code||outcome.reason?.message),/SQLITE_BUSY|database is locked/i);
  }
  const remaining=await admins(db);
  assert.ok(remaining.length>=1,`at least one admin remains: ${JSON.stringify(outcomes.map(o=>o.value||o.reason?.code))}`);
  const revoked=(await audits(db)).filter(row=>row[1]==='admin.revoked').length;
  assert.equal(revoked,3-remaining.length);
});

test('two admins revoking each other concurrently leave exactly one admin',async()=>{
  const {db,url}=await fixture();
  const one=await recentSession(db,1);
  await admin(db,1,2,'grant_admin',one);
  const second=await connect(url);
  const two=await recentSession(second,2);
  const outcomes=await Promise.allSettled([
    admin(db,1,2,'revoke_admin',one),
    admin(second,2,1,'revoke_admin',two),
  ]);
  const ok=outcomes.filter(outcome=>outcome.status==='fulfilled'&&outcome.value.ok);
  assert.equal(ok.length,1,JSON.stringify(outcomes.map(o=>o.value||o.reason?.message)));
  assert.equal((await admins(db)).length,1);
});

test('input validation rejects malformed owner and admin requests before any transaction',async()=>{
  await assert.rejects(changeCircleOwnerRole(null,{actorUserId:1,targetUserId:2,circleId:10,action:'make_owner'}),TypeError);
  await assert.rejects(changeCircleOwnerRole({transaction(){}},{actorUserId:0,targetUserId:2,circleId:10,action:'make_owner'}),TypeError);
  await assert.rejects(changeAppAdmin({transaction(){}},{actorUserId:1,targetUserId:2,circleId:10,action:'promote'}),TypeError);
  await assert.rejects(changeAppAdmin(null,{actorUserId:1,targetUserId:2,circleId:10,action:'grant_admin'}),TypeError);
});

test('an audit failure rolls owner and admin changes back',async()=>{
  const {db}=await fixture();
  const session=await recentSession(db,1);
  await db.execute(`DROP TABLE circle_audit_events`);
  await assert.rejects(role(db,1,2,'make_owner',session));
  await assert.rejects(admin(db,1,2,'grant_admin',session));
  assert.equal((await roles(db))[2],'member/active');
  assert.deepEqual(await admins(db),[1]);
});
