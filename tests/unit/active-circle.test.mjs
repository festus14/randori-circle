import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  accountHasMultipleActiveCircles,
  canUseLegacySinglePrimaryCircleFeatures,
  listSessionCircleContexts,
  resolveActiveCircleContext,
  secondaryCircleScheduleEmailEnabled,
  secondaryCircleSchedulingEnabled,
  selectActiveCircleContext,
} from '../../api/_active-circle.js';
import { getAvailabilityState, updateAvailability } from '../../api/_availability.js';
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
  MULTI_CIRCLE_AVAILABILITY_ENABLED:process.env.MULTI_CIRCLE_AVAILABILITY_ENABLED,
  SECONDARY_CIRCLE_COORDINATION_ENABLED:process.env.SECONDARY_CIRCLE_COORDINATION_ENABLED,
  SECONDARY_CIRCLE_SCHEDULING_ENABLED:process.env.SECONDARY_CIRCLE_SCHEDULING_ENABLED,
  SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED:process.env.SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED,
};

afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
  for(const [key,value] of Object.entries(originalEnvironment)){
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
});

test('secondary scheduling is default-off and requires the complete coordination flag chain',()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  process.env.MULTI_CIRCLE_AVAILABILITY_ENABLED='true';
  delete process.env.SECONDARY_CIRCLE_SCHEDULING_ENABLED;
  assert.equal(secondaryCircleSchedulingEnabled(),false);
  process.env.SECONDARY_CIRCLE_SCHEDULING_ENABLED='true';
  assert.equal(secondaryCircleSchedulingEnabled(),false);
  process.env.SECONDARY_CIRCLE_COORDINATION_ENABLED='true';
  assert.equal(secondaryCircleSchedulingEnabled(),true);
  delete process.env.MULTI_CIRCLE_AVAILABILITY_ENABLED;
  assert.equal(secondaryCircleSchedulingEnabled(),false);
});

test('secondary schedule email is independently default-off and requires scheduling',()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  process.env.MULTI_CIRCLE_AVAILABILITY_ENABLED='true';
  process.env.SECONDARY_CIRCLE_COORDINATION_ENABLED='true';
  process.env.SECONDARY_CIRCLE_SCHEDULING_ENABLED='true';
  delete process.env.SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED;
  assert.equal(secondaryCircleScheduleEmailEnabled(),false);
  process.env.SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED='true';
  assert.equal(secondaryCircleScheduleEmailEnabled(),true);
  delete process.env.SECONDARY_CIRCLE_SCHEDULING_ENABLED;
  assert.equal(secondaryCircleScheduleEmailEnabled(),false);
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
  process.env.MULTI_CIRCLE_AVAILABILITY_ENABLED='true';
  const ownerToken=await issueSession(db,{id:1,email:'owner@example.test',name:'Owner'});
  const ownerPayload=await verifyRequestAuth(request(ownerToken),db);
  const secondToken=await issueSession(db,{id:1,email:'owner@example.test',name:'Owner'});
  const secondPayload=await verifyRequestAuth(request(secondToken),db);
  const memberToken=await issueSession(db,{id:2,email:'member@example.test',name:'Member'});
  return {db,ownerPayload,secondPayload,memberToken};
}

function availabilityContext(payload,resolved){
  return {
    payload,circleId:resolved.membership.id,contextVersion:resolved.context_version,
    implicit:resolved.implicit,
  };
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

test('active-circle availability is independently scoped across switches on the same session',async()=>{
  const {db,ownerPayload}=await fixture();
  await db.execute(`UPDATE auth_accounts SET is_available=0 WHERE id=1`);
  const primarySelection=await selectActiveCircleContext(db,ownerPayload,{
    circlePublicId:'circle-primary',expectedContextVersion:0,
  });
  let active=await resolveActiveCircleContext(db,ownerPayload);
  const primaryContext=availabilityContext(ownerPayload,active);
  const primary=await getAvailabilityState(db,{userId:1,now:'2026-09-18T12:00:00.000Z',circleContext:primaryContext});
  assert.equal(primary.source,'legacy_bridge');
  assert.equal(primary.isAvailable,false);

  const secondarySelection=await selectActiveCircleContext(db,ownerPayload,{
    circlePublicId:'circle-secondary',expectedContextVersion:primarySelection.context_version,
  });
  active=await resolveActiveCircleContext(db,ownerPayload);
  const secondaryContext=availabilityContext(ownerPayload,active);
  const secondary=await getAvailabilityState(db,{userId:1,now:'2026-09-18T12:00:00.000Z',circleContext:secondaryContext});
  assert.equal(secondary.source,'cycle_default');
  assert.equal(secondary.isAvailable,true);
  const secondaryUpdated=await updateAvailability(db,{
    userId:1,now:'2026-09-18T12:00:00.000Z',circleContext:secondaryContext,
    body:{cycle_key:secondary.cycleKey,expected_version:0,is_available:false},
  });
  assert.equal(secondaryUpdated.isAvailable,false);

  await selectActiveCircleContext(db,ownerPayload,{
    circlePublicId:'circle-primary',expectedContextVersion:secondarySelection.context_version,
  });
  active=await resolveActiveCircleContext(db,ownerPayload);
  const primaryAgain=await getAvailabilityState(db,{
    userId:1,now:'2026-09-18T12:00:00.000Z',circleContext:availabilityContext(ownerPayload,active),
  });
  assert.equal(primaryAgain.cycleKey,primary.cycleKey);
  assert.equal(primaryAgain.isAvailable,false);
  assert.notEqual(primaryAgain.cycleKey,secondary.cycleKey);
  const rows=await db.execute(`SELECT scope_key,is_available,version FROM pairing_cycle_availability ORDER BY scope_key`);
  assert.deepEqual(rows.rows.map(row=>[row.scope_key,Number(row.is_available),Number(row.version)]),[
    ['circle:20',0,1],
  ]);
});

test('stale and removed contexts fail before availability materialization',async()=>{
  const {db,ownerPayload}=await fixture();
  const selected=await selectActiveCircleContext(db,ownerPayload,{
    circlePublicId:'circle-primary',expectedContextVersion:0,
  });
  const staleContext={payload:ownerPayload,circleId:10,contextVersion:selected.context_version,implicit:false};
  await selectActiveCircleContext(db,ownerPayload,{
    circlePublicId:'circle-secondary',expectedContextVersion:selected.context_version,
  });
  await assert.rejects(getAvailabilityState(db,{
    userId:1,now:'2026-09-18T12:00:00.000Z',circleContext:staleContext,
  }),error=>error?.code==='AVAILABILITY_CONTEXT_CHANGED');
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM pairing_cycles`)).rows[0].count),0);

  const live=await resolveActiveCircleContext(db,ownerPayload);
  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=20 AND user_id=1`);
  await assert.rejects(updateAvailability(db,{
    userId:1,now:'2026-09-18T12:00:00.000Z',circleContext:availabilityContext(ownerPayload,live),
    body:{cycle_key:'a'.repeat(64),expected_version:0,is_available:false},
  }),error=>error?.code==='AVAILABILITY_CONTEXT_CHANGED');
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM pairing_cycle_availability`)).rows[0].count),0);
});

test('an implicit sole-secondary context supports independent GET and POST with cycle_default',async()=>{
  const {db}=await fixture();
  await db.execute(`UPDATE auth_accounts SET is_available=0 WHERE id=3`);
  const otherToken=await issueSession(db,{id:3,email:'other@example.test',name:'Other'});
  const otherPayload=await verifyRequestAuth(request(otherToken),db);
  const implicitSecondary=await resolveActiveCircleContext(db,otherPayload);
  assert.equal(implicitSecondary.implicit,true);
  assert.equal(implicitSecondary.membership.is_primary,false);
  const context=availabilityContext(otherPayload,implicitSecondary);
  const initial=await getAvailabilityState(db,{
    userId:3,now:'2026-09-18T12:00:00.000Z',circleContext:context,
  });
  assert.equal(initial.source,'cycle_default');
  assert.equal(initial.isAvailable,true,'a secondary circle must not inherit the account-global false value');
  assert.equal(initial.version,0);
  const updated=await updateAvailability(db,{
    userId:3,now:'2026-09-18T12:00:00.000Z',circleContext:availabilityContext(otherPayload,implicitSecondary),
    body:{cycle_key:initial.cycleKey,expected_version:0,is_available:false},
  });
  assert.equal(updated.isAvailable,false);
  assert.equal(updated.source,'user');
  assert.equal(updated.version,1);
  assert.equal(Number((await db.execute({sql:`SELECT COUNT(*) AS count FROM auth_session_circle_contexts
    WHERE session_hash=?`,args:[otherPayload.sessionHash]})).rows[0].count),0,
  'implicit availability must not create a session context row');
  const stored=await db.execute(`SELECT scope_key,user_id,is_available,version
    FROM pairing_cycle_availability WHERE user_id=3`);
  assert.deepEqual(stored.rows.map(row=>[
    row.scope_key,Number(row.user_id),Number(row.is_available),Number(row.version),
  ]),[['circle:30',3,0,1]]);
});

test('implicit sole-primary availability retains the legacy bridge without a stored context',async()=>{
  const {db,ownerPayload}=await fixture();
  await db.execute(`DELETE FROM circle_memberships WHERE circle_id=20 AND user_id=1`);
  await db.execute(`UPDATE auth_accounts SET is_available=0 WHERE id=1`);
  const active=await resolveActiveCircleContext(db,ownerPayload);
  assert.equal(active.implicit,true);
  const state=await getAvailabilityState(db,{
    userId:1,now:'2026-09-18T12:00:00.000Z',circleContext:availabilityContext(ownerPayload,active),
  });
  assert.equal(state.source,'legacy_bridge');
  assert.equal(state.isAvailable,false);
});

test('availability rejects archived circles and revoked sessions without creating a cycle',async()=>{
  const {db,ownerPayload,secondPayload}=await fixture();
  const first=await selectActiveCircleContext(db,ownerPayload,{
    circlePublicId:'circle-secondary',expectedContextVersion:0,
  });
  await db.execute(`UPDATE circles SET archived_at='2026-09-19T00:00:00.000Z' WHERE id=20`);
  await assert.rejects(getAvailabilityState(db,{
    userId:1,now:'2026-09-18T12:00:00.000Z',
    circleContext:{payload:ownerPayload,circleId:20,contextVersion:first.context_version,implicit:false},
  }),error=>error?.code==='AVAILABILITY_CONTEXT_CHANGED');
  await db.execute(`UPDATE circles SET archived_at=NULL WHERE id=20`);

  const second=await selectActiveCircleContext(db,secondPayload,{
    circlePublicId:'circle-secondary',expectedContextVersion:0,
  });
  await db.execute({sql:`UPDATE auth_sessions SET revoked_at=?,revocation_reason='current_logout' WHERE session_hash=?`,
    args:[Math.floor(Date.now()/1000),secondPayload.sessionHash]});
  await assert.rejects(getAvailabilityState(db,{
    userId:1,now:'2026-09-18T12:00:00.000Z',
    circleContext:{payload:secondPayload,circleId:20,contextVersion:second.context_version,implicit:false},
  }),error=>error?.code==='AVAILABILITY_CONTEXT_CHANGED');
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM pairing_cycles`)).rows[0].count),0);
});

test('availability revalidates the exact context on every transaction retry',async()=>{
  const {db,ownerPayload}=await fixture();
  const selected=await selectActiveCircleContext(db,ownerPayload,{
    circlePublicId:'circle-secondary',expectedContextVersion:0,
  });
  let validations=0;
  let transactions=0;
  const wrapper={
    execute:value=>db.execute(value),
    batch:(values,mode)=>db.batch(values,mode),
    async transaction(mode){
      transactions+=1;
      const transaction=await db.transaction(mode);
      return {
        async execute(value){
          const sql=typeof value==='string'?value:String(value?.sql||'');
          if(sql.includes('SELECT membership.circle_id')&&sql.includes('FROM auth_sessions session')){
            validations+=1;
            if(validations===1) throw Object.assign(new Error('database is busy'),{code:'SQLITE_BUSY'});
          }
          return transaction.execute(value);
        },
        batch:(values,batchMode)=>transaction.batch(values,batchMode),
        commit:()=>transaction.commit(),rollback:()=>transaction.rollback(),close:()=>transaction.close?.(),
      };
    },
  };
  const state=await getAvailabilityState(wrapper,{
    userId:1,now:'2026-09-18T12:00:00.000Z',
    circleContext:{payload:ownerPayload,circleId:20,contextVersion:selected.context_version,implicit:false},
  });
  assert.equal(state.source,'cycle_default');
  assert.equal(transactions,2);
  assert.equal(validations,2);
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
  const memberPayload=await verifyRequestAuth(request(memberToken),db);
  const selected=await selectActiveCircleContext(db,memberPayload,{
    circlePublicId:'circle-secondary',expectedContextVersion:0,
  });
  const first=await leaveCircle(db,{
    actorUserId:2,circleId:20,
    circleContext:{payload:memberPayload,contextVersion:selected.context_version,implicit:false},
  });
  assert.equal(first.ok,true);
  assert.equal(first.signed_out,false);
  assert.equal(first.revoked_sessions,0);
  assert.equal(first.context_version,2);
  assert.equal((await verifyRequestAuth(request(memberToken),db))?.id,2);
  const unselected=await listSessionCircleContexts(db,memberPayload);
  assert.equal(unselected.active,null);
  assert.equal(unselected.selection_required,true);
  assert.equal(unselected.context_version,2);
  assert.deepEqual(await selectActiveCircleContext(db,memberPayload,{
    circlePublicId:'circle-primary',expectedContextVersion:selected.context_version,
  }),{ok:false,reason:'context_changed',context_version:2});
  const recovered=await selectActiveCircleContext(db,memberPayload,{
    circlePublicId:'circle-primary',expectedContextVersion:unselected.context_version,
  });
  assert.equal(recovered.context_version,3);
  const final=await leaveCircle(db,{
    actorUserId:2,circleId:10,
    circleContext:{payload:memberPayload,contextVersion:recovered.context_version,implicit:false},
  });
  assert.equal(final.ok,true);
  assert.equal(final.signed_out,true);
  assert.equal(final.revoked_sessions,1);
  assert.equal(final.context_version,4);
  assert.equal(await verifyRequestAuth(request(memberToken),db),null);
});

test('single-circle accounts retain implicit selection and flag-off auth remains primary-only',async()=>{
  const {db}=await fixture();
  const token=await issueSession(db,{id:3,email:'other@example.test',name:'Other'});
  const payload=await verifyRequestAuth(request(token),db);
  const context=await listSessionCircleContexts(db,payload);
  assert.equal(context.selection_required,false);
  assert.equal(context.implicit,true);
  assert.equal(context.active.public_id,'circle-private');
  assert.equal(await accountHasMultipleActiveCircles(db,3),false);
  assert.equal(await canUseLegacySinglePrimaryCircleFeatures(db,payload),false,
    'a sole secondary membership cannot enter legacy primary-scoped features');
  assert.equal(await accountHasMultipleActiveCircles(db,1),true);
  delete process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED;
  assert.equal(await verifyRequestAuth(request(token),db),null,
    'legacy auth must not admit a secondary-only account while the control plane is off');
  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  const enabledToken=await issueSession(db,{id:3,email:'other@example.test',name:'Other'});
  assert.equal((await verifyRequestAuth(request(enabledToken),db))?.id,3);
});

test('legacy features require one resolved primary circle and reject a stale stored selection',async()=>{
  const {db,memberToken}=await fixture();
  const memberPayload=await verifyRequestAuth(request(memberToken),db);
  assert.equal(await canUseLegacySinglePrimaryCircleFeatures(db,memberPayload),false,
    'two memberships remain ambiguous even before selection');
  const selected=await selectActiveCircleContext(db,memberPayload,{
    circlePublicId:'circle-secondary',expectedContextVersion:0,
  });
  assert.equal(await canUseLegacySinglePrimaryCircleFeatures(db,memberPayload),false,
    'selecting a secondary circle cannot authorize primary-keyed data');
  await db.execute(`UPDATE circle_memberships SET status='inactive'
    WHERE circle_id=20 AND user_id=2`);
  assert.equal((await listSessionCircleContexts(db,memberPayload)).selection_required,true);
  assert.equal(await canUseLegacySinglePrimaryCircleFeatures(db,memberPayload),false,
    'a stale stored selection cannot silently fall back to the sole primary circle');
  const primary=await selectActiveCircleContext(db,memberPayload,{
    circlePublicId:'circle-primary',expectedContextVersion:selected.context_version,
  });
  assert.equal(primary.context_version,2);
  assert.equal(await canUseLegacySinglePrimaryCircleFeatures(db,memberPayload),true,
    'an explicitly recovered sole primary circle retains legacy compatibility');
});

test('stale context cannot mutate the old circle after another request switches sessions',async()=>{
  const {db,ownerPayload}=await fixture();
  const selectedA=await selectActiveCircleContext(db,ownerPayload,{
    circlePublicId:'circle-primary',expectedContextVersion:0,
  });
  assert.equal(selectedA.context_version,1);
  const selectedB=await selectActiveCircleContext(db,ownerPayload,{
    circlePublicId:'circle-secondary',expectedContextVersion:1,
  });
  assert.equal(selectedB.context_version,2);
  const stale=await changeCircleMemberStatus(db,{
    actorUserId:1,targetUserId:2,circleId:10,action:'deactivate',
    circleContext:{payload:ownerPayload,contextVersion:1,implicit:false},
  });
  assert.deepEqual(stale,{ok:false,reason:'context_changed'});
  const membership=await db.execute(`SELECT status FROM circle_memberships WHERE circle_id=10 AND user_id=2`);
  assert.equal(membership.rows[0].status,'active');
});

test('deactivation bumps the selected-session generation and prevents context ABA',async()=>{
  const {db,ownerPayload}=await fixture();
  const ownerSelected=await selectActiveCircleContext(db,ownerPayload,{
    circlePublicId:'circle-primary',expectedContextVersion:0,
  });
  const memberToken=await issueSession(db,{id:2,email:'member@example.test',name:'Member'});
  const memberPayload=await verifyRequestAuth(request(memberToken),db);
  const memberSelected=await selectActiveCircleContext(db,memberPayload,{
    circlePublicId:'circle-primary',expectedContextVersion:0,
  });
  assert.equal(memberSelected.context_version,1);

  const deactivated=await changeCircleMemberStatus(db,{
    actorUserId:1,targetUserId:2,circleId:10,action:'deactivate',
    circleContext:{payload:ownerPayload,contextVersion:ownerSelected.context_version,implicit:false},
  });
  assert.equal(deactivated.ok,true);
  const inactive=await listSessionCircleContexts(db,memberPayload);
  assert.equal(inactive.context_version,2);
  assert.equal(inactive.active,null);
  assert.equal(inactive.selection_required,true);
  assert.equal(inactive.implicit,false);

  const staleRecovery=await selectActiveCircleContext(db,memberPayload,{
    circlePublicId:'circle-secondary',expectedContextVersion:memberSelected.context_version,
  });
  assert.deepEqual(staleRecovery,{ok:false,reason:'context_changed',context_version:2});
  const recovered=await selectActiveCircleContext(db,memberPayload,{
    circlePublicId:'circle-secondary',expectedContextVersion:inactive.context_version,
  });
  assert.equal(recovered.ok,true);
  assert.equal(recovered.context_version,3);

  const reactivated=await changeCircleMemberStatus(db,{
    actorUserId:1,targetUserId:2,circleId:10,action:'reactivate',
    circleContext:{payload:ownerPayload,contextVersion:ownerSelected.context_version,implicit:false},
  });
  assert.equal(reactivated.ok,true);
  const after=await listSessionCircleContexts(db,memberPayload);
  assert.equal(after.active.public_id,'circle-secondary');
  assert.equal(after.context_version,3);
  assert.equal(after.context_version===memberSelected.context_version,false,
    'reactivation cannot resurrect the stale v1 generation');
});
