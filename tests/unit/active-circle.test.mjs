import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  accountHasMultipleActiveCircles,
  listSessionCircleContexts,
  selectActiveCircleContext,
} from '../../api/_active-circle.js';
import { changeCircleMemberStatus, leaveCircle, listCircleMembersForOwner } from '../../api/_member-lifecycle.js';
import { issueSession, verifyRequestAuth } from '../../api/_db.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const JWT_SECRET='active-circle-test-secret-at-least-thirty-two-bytes';
const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const resources=[];
const originalEnvironment={
  JWT_SECRET:process.env.JWT_SECRET,
  CIRCLE_MEMBERSHIP_ENABLED:process.env.CIRCLE_MEMBERSHIP_ENABLED,
  MULTI_CIRCLE_CONTROL_PLANE_ENABLED:process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED,
};

afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
  for(const [key,value] of Object.entries(originalEnvironment)){
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
});

function request(token){
  return {headers:{cookie:`randori_session=${encodeURIComponent(token)}`}};
}

async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-active-circle-'));
  const db=createClient({url:`file:${join(directory,'database.sqlite')}`});
  resources.push(async()=>{ await db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db,{migrations:EXECUTABLE_MIGRATIONS});
  await applyMigrations(db,{migrations:EXECUTABLE_MIGRATIONS,expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY});
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
      (1,'owner@example.test','x','Owner','#111111',0),
      (2,'member@example.test','x','Member','#222222',0),
      (3,'other@example.test','x','Other','#333333',0)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES
      (10,'circle-primary','primary','Primary',1,1),
      (20,'circle-secondary','secondary','Secondary',0,1),
      (30,'circle-private','private','Private',0,3)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES
      (10,1,'owner','active'),(10,2,'member','active'),
      (20,1,'owner','active'),(20,2,'member','active'),
      (30,3,'owner','active')`,
  ],'write');
  process.env.JWT_SECRET=JWT_SECRET;
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  const ownerToken=await issueSession(db,{id:1,email:'owner@example.test',name:'Owner'});
  const ownerPayload=await verifyRequestAuth(request(ownerToken),db);
  const secondToken=await issueSession(db,{id:1,email:'owner@example.test',name:'Owner'});
  const secondPayload=await verifyRequestAuth(request(secondToken),db);
  const memberToken=await issueSession(db,{id:2,email:'member@example.test',name:'Member'});
  return {db,ownerPayload,secondPayload,memberToken};
}

test('a multi-circle account must select a session-bound active circle with monotonic CAS',async()=>{
  const {db,ownerPayload,secondPayload}=await fixture();
  const initial=await listSessionCircleContexts(db,ownerPayload);
  assert.equal(initial.selection_required,true);
  assert.equal(initial.active,null);
  assert.equal(initial.context_version,0);
  assert.deepEqual(initial.circles.map(circle=>[circle.public_id,circle.role,circle.is_primary]),[
    ['circle-primary','owner',true],['circle-secondary','owner',false],
  ]);

  const selected=await selectActiveCircleContext(db,ownerPayload,{
    circlePublicId:'circle-secondary',expectedContextVersion:0,nowSeconds:Math.floor(Date.now()/1000),
  });
  assert.equal(selected.ok,true);
  assert.equal(selected.changed,true);
  assert.equal(selected.context_version,1);
  assert.equal(selected.membership.public_id,'circle-secondary');

  const current=await listSessionCircleContexts(db,ownerPayload);
  assert.equal(current.selection_required,false);
  assert.equal(current.active.public_id,'circle-secondary');
  assert.equal(current.context_version,1);
  assert.equal((await listSessionCircleContexts(db,secondPayload)).selection_required,true,
    'selection is bound to the exact live session');

  assert.deepEqual(await selectActiveCircleContext(db,ownerPayload,{
    circlePublicId:'circle-primary',expectedContextVersion:0,
  }),{ok:false,reason:'context_changed',context_version:1});
  const unchanged=await selectActiveCircleContext(db,ownerPayload,{
    circlePublicId:'circle-secondary',expectedContextVersion:1,
  });
  assert.equal(unchanged.changed,false);
  assert.equal(unchanged.context_version,1);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM circle_audit_events
    WHERE event_type='circle.context.selected'`)).rows[0].count),1);
});

test('selection and control-plane reads never reveal or mutate another account circle',async()=>{
  const {db,ownerPayload}=await fixture();
  const denied=await selectActiveCircleContext(db,ownerPayload,{
    circlePublicId:'circle-private',expectedContextVersion:0,
  });
  assert.deepEqual(denied,{ok:false,reason:'circle_unavailable'});
  assert.equal((await db.execute(`SELECT COUNT(*) AS count FROM auth_session_circle_contexts`)).rows[0].count,0);
  assert.equal(JSON.stringify(await listSessionCircleContexts(db,ownerPayload)).includes('circle-private'),false);
});

test('roster and lifecycle writes stay inside the selected circle',async()=>{
  const {db,memberToken}=await fixture();
  const roster=await listCircleMembersForOwner(db,{
    actorUserId:1,circleId:20,cursorSecret:JWT_SECRET,
  });
  assert.deepEqual(roster.members.map(member=>member.id),[1,2]);
  const changed=await changeCircleMemberStatus(db,{
    actorUserId:1,targetUserId:2,circleId:20,action:'deactivate',
  });
  assert.equal(changed.ok,true);
  assert.equal(changed.revoked_sessions,0,'another active circle keeps the account session valid');
  const memberships=await db.execute(`SELECT circle_id,status FROM circle_memberships
    WHERE user_id=2 ORDER BY circle_id`);
  assert.deepEqual(memberships.rows.map(row=>[Number(row.circle_id),row.status]),[
    [10,'active'],[20,'inactive'],
  ]);
  assert.equal((await verifyRequestAuth(request(memberToken),db))?.id,2);
});

test('leaving one circle keeps the session while leaving the final circle revokes it',async()=>{
  const {db,memberToken}=await fixture();
  const first=await leaveCircle(db,{actorUserId:2,circleId:20});
  assert.equal(first.ok,true);
  assert.equal(first.signed_out,false);
  assert.equal(first.revoked_sessions,0);
  assert.equal((await verifyRequestAuth(request(memberToken),db))?.id,2);
  const final=await leaveCircle(db,{actorUserId:2,circleId:10});
  assert.equal(final.ok,true);
  assert.equal(final.signed_out,true);
  assert.equal(final.revoked_sessions,1);
  assert.equal(await verifyRequestAuth(request(memberToken),db),null);
});

test('single-circle accounts retain implicit selection and multi-circle detection is bounded',async()=>{
  const {db}=await fixture();
  const token=await issueSession(db,{id:3,email:'other@example.test',name:'Other'});
  const payload=await verifyRequestAuth(request(token),db);
  const context=await listSessionCircleContexts(db,payload);
  assert.equal(context.selection_required,false);
  assert.equal(context.implicit,true);
  assert.equal(context.active.public_id,'circle-private');
  assert.equal(await accountHasMultipleActiveCircles(db,3),false);
  assert.equal(await accountHasMultipleActiveCircles(db,1),true);
  delete process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED;
  assert.equal((await verifyRequestAuth(request(token),db))?.id,3,
    'control-plane rollback does not revoke a valid secondary-only account session');
});
