import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  MEMBER_PAGE_MAX,
  MemberRosterQueryError,
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
const NOW=Math.floor(Date.now()/1000);
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

async function recentSession(db,id,email,{authenticatedAt=NOW}={}){
  const token=await issueSession(db,{id,email,name:`Member ${id}`},{
    recentAuthMethod:'password',nowSeconds:authenticatedAt,
  });
  return verifyRequestAuth(request(token),db,{nowSeconds:NOW});
}

test('owner listing is private, bounded, and includes inactive members without email addresses',async()=>{
  const {db}=await fixture();
  const result=await listCircleMembersForOwner(db,{actorUserId:1,cursorSecret:JWT_SECRET});
  assert.equal(result.ok,true);
  assert.deepEqual(result.members.map(member=>[member.id,member.role,member.status]),[
    [1,'owner','active'],[2,'member','active'],[3,'owner','inactive'],
  ]);
  assert.equal(result.has_more,false);
  assert.equal(result.next_cursor,null);
  assert.equal(result.scanned,3);
  assert.equal(JSON.stringify(result).includes('@example.test'),false);
  assert.deepEqual(await listCircleMembersForOwner(db,{actorUserId:2,cursorSecret:JWT_SECRET}),{ok:false,reason:'owner_required'});
  assert.deepEqual(await listCircleMembersForOwner(db,{actorUserId:4,cursorSecret:JWT_SECRET}),{ok:false,reason:'owner_required'});
});

test('the roster range is served by the circle and user membership index',async()=>{
  const {db}=await fixture();
  const plan=await db.execute(`EXPLAIN QUERY PLAN
    SELECT membership.user_id,account.display_name
    FROM circle_memberships membership
    JOIN auth_accounts account ON account.id=membership.user_id
    WHERE membership.circle_id=10 AND membership.user_id>0 AND membership.user_id<=999999
      AND COALESCE(account.is_demo,0)=0
    ORDER BY membership.user_id LIMIT 201`);
  const details=plan.rows.map(row=>String(row.detail||'')).join('\n');
  assert.match(details,/SEARCH membership USING (?:COVERING )?INDEX .*circle_memberships.*\(circle_id=\? AND user_id>\? AND user_id<\?\)/i);
  assert.doesNotMatch(details,/SCAN membership/i);
});

test('an owner pages through more than 500 members without gaps when status changes between pages',async()=>{
  const {db}=await fixture();
  await db.execute(`WITH RECURSIVE sequence(id) AS (
      VALUES(1000) UNION ALL SELECT id+1 FROM sequence WHERE id<1500
    ) INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo)
      SELECT id,'member-'||id||'@example.test','x','Member '||id,'#123456',0 FROM sequence`);
  await db.execute(`WITH RECURSIVE sequence(id) AS (
      VALUES(1000) UNION ALL SELECT id+1 FROM sequence WHERE id<1500
    ) INSERT INTO circle_memberships (circle_id,user_id,role,status)
      SELECT 10,id,'member','active' FROM sequence`);
  const seen=[];
  let cursor=null;
  let pages=0;
  do{
    const result=await listCircleMembersForOwner(db,{actorUserId:1,cursor,cursorSecret:JWT_SECRET,limit:MEMBER_PAGE_MAX});
    assert.equal(result.ok,true);
    assert.ok(result.members.length<=MEMBER_PAGE_MAX);
    seen.push(...result.members.map(member=>member.id));
    cursor=result.next_cursor;
    pages+=1;
    if(pages===1){
      await db.execute(`UPDATE circle_memberships SET status='inactive',updated_at=CURRENT_TIMESTAMP
        WHERE circle_id=10 AND user_id=1200`);
    }
    assert.equal(result.has_more,Boolean(cursor));
  }while(cursor);
  assert.ok(pages>5);
  assert.equal(seen.length,504);
  assert.equal(new Set(seen).size,seen.length);
  assert.deepEqual(seen,[...seen].sort((a,b)=>a-b));
  const changedIndex=seen.indexOf(1200);
  assert.ok(changedIndex>MEMBER_PAGE_MAX);
});

test('display-name search is bounded, private, cursor-bound, and reaches late matches',async()=>{
  const {db}=await fixture();
  await db.execute(`WITH RECURSIVE sequence(id) AS (
      VALUES(1000) UNION ALL SELECT id+1 FROM sequence WHERE id<1500
    ) INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo)
      SELECT id,'private-'||id||'@example.test','x',CASE WHEN id=1499 THEN 'Ada Search Target' ELSE 'Member '||id END,'#123456',0 FROM sequence`);
  await db.execute(`WITH RECURSIVE sequence(id) AS (
      VALUES(1000) UNION ALL SELECT id+1 FROM sequence WHERE id<1500
    ) INSERT INTO circle_memberships (circle_id,user_id,role,status)
      SELECT 10,id,'member','active' FROM sequence`);
  let cursor=null;
  let pages=0;
  const found=[];
  do{
    const result=await listCircleMembersForOwner(db,{actorUserId:1,cursor,search:'  ADA   search ',cursorSecret:JWT_SECRET,limit:10});
    assert.ok(result.scanned<=200);
    assert.equal(JSON.stringify(result).includes('@example.test'),false);
    found.push(...result.members);
    cursor=result.next_cursor;
    pages+=1;
  }while(cursor);
  assert.ok(pages>=3);
  assert.deepEqual(found.map(member=>[member.id,member.display_name]),[[1499,'Ada Search Target']]);
});

test('malformed, tampered, reused, and cross-actor cursors fail opaquely',async()=>{
  const {db}=await fixture();
  await db.execute(`UPDATE circle_memberships SET status='active' WHERE circle_id=10 AND user_id=3`);
  const first=await listCircleMembersForOwner(db,{actorUserId:1,cursorSecret:JWT_SECRET,limit:1});
  assert.equal(first.has_more,true);
  const cursor=first.next_cursor;
  const replacement=cursor.endsWith('A')?'B':'A';
  for(const input of [
    {actorUserId:1,cursor:'not-a-cursor',search:'',cursorSecret:JWT_SECRET},
    {actorUserId:1,cursor:`${cursor.slice(0,-1)}${replacement}`,search:'',cursorSecret:JWT_SECRET},
    {actorUserId:1,cursor,search:'different',cursorSecret:JWT_SECRET},
    {actorUserId:3,cursor,search:'',cursorSecret:JWT_SECRET},
  ]){
    await assert.rejects(listCircleMembersForOwner(db,input),error=>error instanceof MemberRosterQueryError&&error.code==='invalid_cursor');
  }
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
  const ownerSession=await recentSession(db,1,'owner@example.test');
  const transferred=await transferCircleOwnership(db,{actorUserId:1,targetUserId:2,session:ownerSession,nowSeconds:NOW});
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
  const nextOwnerSession=await recentSession(db,2,'member@example.test');
  assert.deepEqual(await transferCircleOwnership(db,{actorUserId:2,targetUserId:4,session:nextOwnerSession,nowSeconds:NOW}),{ok:false,reason:'not_found'});
});

test('owner deactivation and ownership transfer require fresh proof before mutation',async()=>{
  const {db}=await fixture();
  await db.execute(`UPDATE circle_memberships SET status='active' WHERE circle_id=10 AND user_id=3`);
  const before=async()=>({
    memberships:(await db.execute(`SELECT user_id,role,status FROM circle_memberships WHERE circle_id=10 ORDER BY user_id`)).rows,
    audits:Number((await db.execute(`SELECT COUNT(*) AS count FROM circle_audit_events`)).rows[0].count),
  });
  const initial=await before();
  await assert.rejects(changeCircleMemberStatus(db,{actorUserId:1,targetUserId:3,action:'deactivate'}),
    error=>error?.code==='RECENT_AUTH_REQUIRED');
  const stale=await recentSession(db,1,'owner@example.test',{authenticatedAt:NOW-601});
  await assert.rejects(transferCircleOwnership(db,{actorUserId:1,targetUserId:2,session:stale,nowSeconds:NOW}),
    error=>error?.code==='RECENT_AUTH_REQUIRED');
  const otherMember=await recentSession(db,2,'member@example.test');
  await assert.rejects(transferCircleOwnership(db,{actorUserId:1,targetUserId:2,session:otherMember,nowSeconds:NOW}),
    error=>error?.code==='RECENT_AUTH_REQUIRED');
  assert.deepEqual(await before(),initial);

  const fresh=await recentSession(db,1,'owner@example.test');
  const deactivated=await changeCircleMemberStatus(db,{
    actorUserId:1,targetUserId:3,action:'deactivate',session:fresh,nowSeconds:NOW,
  });
  assert.equal(deactivated.ok,true);
  assert.equal((await db.execute(`SELECT status FROM circle_memberships WHERE circle_id=10 AND user_id=3`)).rows[0].status,'inactive');
});

test('concurrent owner removals preserve one active owner',async()=>{
  const {db,url}=await fixture();
  await db.execute(`UPDATE circle_memberships SET status='active' WHERE circle_id=10 AND user_id=3`);
  const second=createClient({url});
  resources.push(async()=>{ await second.close(); });
  await prepareMigrationConnection(second);
  const firstSession=await recentSession(db,1,'owner@example.test');
  const secondSession=await recentSession(second,3,'owner-two@example.test');

  const outcomes=await Promise.allSettled([
    changeCircleMemberStatus(db,{actorUserId:1,targetUserId:3,action:'deactivate',session:firstSession,nowSeconds:NOW}),
    changeCircleMemberStatus(second,{actorUserId:3,targetUserId:1,action:'deactivate',session:secondSession,nowSeconds:NOW}),
  ]);
  const successes=outcomes.filter(outcome=>outcome.status==='fulfilled'&&outcome.value.ok);
  assert.equal(successes.length,1,JSON.stringify(outcomes.map(outcome=>outcome.status==='fulfilled'
    ?outcome.value:{code:outcome.reason?.code,message:outcome.reason?.message})));
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
