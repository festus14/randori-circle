import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  MEMBER_LIST_LIMIT,
  changeCircleMemberStatus,
  leaveCircle,
  listCircleMembersForOwner,
  transferCircleOwnership,
} from '../../api/_member-lifecycle.js';
import { issueSession, verifyRequestAuth } from '../../api/_db.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const JWT_SECRET='member-lifecycle-test-secret-at-least-thirty-two-bytes';
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

function request(token){
  return {headers:{cookie:`randori_session=${encodeURIComponent(token)}`}};
}

async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-member-lifecycle-'));
  const path=join(directory,'database.sqlite');
  const url=`file:${path}`;
  const db=createClient({url});
  resources.push(async()=>{ await db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db,{migrations:EXECUTABLE_MIGRATIONS});
  await applyMigrations(db,{migrations:EXECUTABLE_MIGRATIONS,expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY});
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
      (1,'owner@example.test','x','Owner','#112233',0),
      (2,'member@example.test','x','Member','#445566',0),
      (3,'owner-two@example.test','x','Owner Two','#778899',0),
      (4,'outsider@example.test','x','Outsider','#aabbcc',0)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES
      (10,'circle-primary','randori-circle','Primary',1,1),
      (20,'circle-other','other-circle','Other',0,4)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES
      (10,1,'owner','active'),(10,2,'member','active'),(10,3,'owner','inactive'),
      (20,4,'owner','active')`,
  ],'write');
  process.env.JWT_SECRET=JWT_SECRET;
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  const memberSessions=[
    await issueSession(db,{id:2,email:'member@example.test',name:'Member'}),
    await issueSession(db,{id:2,email:'member@example.test',name:'Member'}),
  ];
  return {db,url,directory,memberSessions};
}

test('owner listing is private, bounded, and includes inactive members without email addresses',async()=>{
  const {db}=await fixture();
  const result=await listCircleMembersForOwner(db,{actorUserId:1});
  assert.equal(result.ok,true);
  assert.deepEqual(result.members.map(member=>[member.id,member.role,member.status]),[
    [1,'owner','active'],[2,'member','active'],[3,'owner','inactive'],
  ]);
  assert.equal(result.truncated,false);
  assert.equal(JSON.stringify(result).includes('@example.test'),false);
  assert.deepEqual(await listCircleMembersForOwner(db,{actorUserId:2}),{ok:false,reason:'owner_required'});
  assert.deepEqual(await listCircleMembersForOwner(db,{actorUserId:4}),{ok:false,reason:'owner_required'});
});

test('owner listing has a hard cap and explicitly reports truncation',async()=>{
  const {db}=await fixture();
  await db.execute(`WITH RECURSIVE sequence(id) AS (
      VALUES(1000) UNION ALL SELECT id+1 FROM sequence WHERE id<1500
    ) INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo)
      SELECT id,'member-'||id||'@example.test','x','Member '||id,'#123456',0 FROM sequence`);
  await db.execute(`WITH RECURSIVE sequence(id) AS (
      VALUES(1000) UNION ALL SELECT id+1 FROM sequence WHERE id<1500
    ) INSERT INTO circle_memberships (circle_id,user_id,role,status)
      SELECT 10,id,'member','active' FROM sequence`);
  const result=await listCircleMembersForOwner(db,{actorUserId:1});
  assert.equal(result.ok,true);
  assert.equal(result.members.length,MEMBER_LIST_LIMIT);
  assert.equal(result.truncated,true);
});

test('deactivation and reactivation are scoped, audited, and revoke every affected session atomically',async()=>{
  const {db,memberSessions}=await fixture();
  assert.equal((await verifyRequestAuth(request(memberSessions[0]),db))?.id,2);
  assert.equal((await verifyRequestAuth(request(memberSessions[1]),db))?.id,2);
  const deactivated=await changeCircleMemberStatus(db,{actorUserId:1,targetUserId:2,action:'deactivate'});
  assert.equal(deactivated.ok,true);
  assert.equal(deactivated.revoked_sessions,2);
  assert.deepEqual(deactivated.member,{id:2,role:'member',status:'inactive'});

  let membership=await db.execute(`SELECT role,status FROM circle_memberships WHERE circle_id=10 AND user_id=2`);
  assert.deepEqual({...membership.rows[0]},{role:'member',status:'inactive'});
  let sessions=await db.execute(`SELECT revoked_at,revocation_reason FROM auth_sessions WHERE user_id=2`);
  assert.ok(sessions.rows.every(row=>Number(row.revoked_at)>0&&row.revocation_reason==='membership_removed'));
  assert.equal(await verifyRequestAuth(request(memberSessions[0]),db),null);
  assert.equal(await verifyRequestAuth(request(memberSessions[1]),db),null);

  const reactivated=await changeCircleMemberStatus(db,{actorUserId:1,targetUserId:2,action:'reactivate'});
  assert.deepEqual(reactivated.member,{id:2,role:'member',status:'active'});
  membership=await db.execute(`SELECT role,status FROM circle_memberships WHERE circle_id=10 AND user_id=2`);
  assert.equal(membership.rows[0].status,'active');
  const audit=await db.execute(`SELECT event_type,actor_user_id,subject_user_id FROM circle_audit_events ORDER BY id`);
  assert.deepEqual(audit.rows.map(row=>[row.event_type,Number(row.actor_user_id),Number(row.subject_user_id)]),[
    ['membership.deactivated',1,2],['membership.reactivated',1,2],
  ]);

  assert.deepEqual(await changeCircleMemberStatus(db,{actorUserId:1,targetUserId:4,action:'deactivate'}),{ok:false,reason:'not_found'});
  assert.deepEqual(await changeCircleMemberStatus(db,{actorUserId:1,targetUserId:999,action:'deactivate'}),{ok:false,reason:'not_found'});
  assert.deepEqual(await changeCircleMemberStatus(db,{actorUserId:1,targetUserId:1,action:'deactivate'}),{ok:false,reason:'self_transition'});
});

test('a member can leave, losing all sessions, while the final active owner cannot leave',async()=>{
  const {db,memberSessions}=await fixture();
  const left=await leaveCircle(db,{actorUserId:2});
  assert.equal(left.ok,true);
  assert.equal(left.revoked_sessions,2);
  assert.equal(await verifyRequestAuth(request(memberSessions[0]),db),null);
  assert.equal(await verifyRequestAuth(request(memberSessions[1]),db),null);
  assert.deepEqual(await leaveCircle(db,{actorUserId:2}),{ok:false,reason:'not_found'});

  const refused=await leaveCircle(db,{actorUserId:1});
  assert.deepEqual(refused,{ok:false,reason:'last_owner'});
  const owner=await db.execute(`SELECT status FROM circle_memberships WHERE circle_id=10 AND user_id=1`);
  assert.equal(owner.rows[0].status,'active');
  const audits=await db.execute(`SELECT event_type,actor_user_id,subject_user_id FROM circle_audit_events`);
  assert.deepEqual(audits.rows.map(row=>[row.event_type,Number(row.actor_user_id),Number(row.subject_user_id)]),[
    ['membership.left',2,2],
  ]);
});

test('ownership transfer atomically promotes the target, demotes the actor, and writes one audit row',async()=>{
  const {db}=await fixture();
  const transferred=await transferCircleOwnership(db,{actorUserId:1,targetUserId:2});
  assert.deepEqual(transferred,{ok:true,previous_owner_id:1,owner_id:2});
  const members=await db.execute(`SELECT user_id,role,status FROM circle_memberships WHERE circle_id=10 ORDER BY user_id`);
  assert.deepEqual(members.rows.map(row=>[Number(row.user_id),row.role,row.status]),[
    [1,'member','active'],[2,'owner','active'],[3,'owner','inactive'],
  ]);
  const audit=await db.execute(`SELECT event_type,actor_user_id,subject_user_id FROM circle_audit_events`);
  assert.deepEqual(audit.rows.map(row=>[row.event_type,Number(row.actor_user_id),Number(row.subject_user_id)]),[
    ['ownership.transferred',1,2],
  ]);
  assert.deepEqual(await transferCircleOwnership(db,{actorUserId:2,targetUserId:2}),{ok:false,reason:'self_transfer'});
  assert.deepEqual(await transferCircleOwnership(db,{actorUserId:2,targetUserId:4}),{ok:false,reason:'not_found'});
});

test('concurrent owner removals preserve one active owner',async()=>{
  const {db,url}=await fixture();
  await db.execute(`UPDATE circle_memberships SET status='active' WHERE circle_id=10 AND user_id=3`);
  const second=createClient({url});
  resources.push(async()=>{ await second.close(); });
  await prepareMigrationConnection(second);

  const outcomes=await Promise.allSettled([
    changeCircleMemberStatus(db,{actorUserId:1,targetUserId:3,action:'deactivate'}),
    changeCircleMemberStatus(second,{actorUserId:3,targetUserId:1,action:'deactivate'}),
  ]);
  const successes=outcomes.filter(outcome=>outcome.status==='fulfilled'&&outcome.value.ok);
  assert.equal(successes.length,1);
  const owners=await db.execute(`SELECT user_id FROM circle_memberships
    WHERE circle_id=10 AND role='owner' AND status='active' ORDER BY user_id`);
  assert.equal(owners.rows.length,1);
  const audits=await db.execute(`SELECT COUNT(*) AS count FROM circle_audit_events WHERE event_type='membership.deactivated'`);
  assert.equal(Number(audits.rows[0].count),1);
});

test('an audit failure rolls membership and session changes back together',async()=>{
  const {db}=await fixture();
  await db.execute(`DROP TABLE circle_audit_events`);
  await assert.rejects(
    changeCircleMemberStatus(db,{actorUserId:1,targetUserId:2,action:'deactivate'}),
  );
  const membership=await db.execute(`SELECT status FROM circle_memberships WHERE circle_id=10 AND user_id=2`);
  assert.equal(membership.rows[0].status,'active');
  const sessions=await db.execute(`SELECT revoked_at FROM auth_sessions WHERE user_id=2`);
  assert.ok(sessions.rows.every(row=>row.revoked_at==null));
});
