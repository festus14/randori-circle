import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  inspectCompletedMembershipRollout,
  inspectMembershipAdoptionReadiness,
  inspectMembershipRolloutReadiness,
} from '../../db/membership-readiness.js';

// Routes each readiness query to a canned result by its distinctive SQL text.
// `null` simulates a driver result that omits `rows`.
function fakeDb({rollout=[{id:1, registrations_closed:1}], primary=[{id:7, created_by:3}], aggregate={}, state={}, activationLedger=[{present:1}]}={}){
  const statements=[];
  return {
    statements,
    async execute(statement){
      const sql=typeof statement==='string'?statement:statement.sql;
      statements.push(statement);
      const rows=value=>value===null?{}:{rows:value};
      if(sql.includes('FROM circle_membership_rollout')) return rows(rollout);
      if(sql.includes('FROM sqlite_schema')) return rows(activationLedger);
      if(sql.includes('is_primary=1')) return rows(primary);
      if(sql.includes('AS completedBackfills')&&!sql.includes('activeOwners')) return rows([aggregate]);
      return rows(state===null?null:[state]);
    },
  };
}

const HEALTHY_ADOPTION_STATE={
  activeOwners:1, matchingBackfills:1, invalidAccountProvenance:0, malformedBackfillAudits:0,
  malformedInvitationAudits:0, malformedActivationAudits:0, uncoveredAccounts:0, orphanMemberships:0,
};
const HEALTHY_COMPLETED_STATE={
  activeOwners:1, canonicalBackfillActors:1, completedBackfills:1, matchingBackfills:1,
  malformedCompletionAudits:0, invalidAccountProvenance:0, malformedBackfillAudits:0,
  malformedInvitationAudits:0, malformedActivationAudits:0, orphanMemberships:0,
};

test('every evaluator requires a client with execute()', async ()=>{
  for(const inspect of [inspectMembershipAdoptionReadiness, inspectCompletedMembershipRollout, inspectMembershipRolloutReadiness]){
    await assert.rejects(inspect(), {name:'TypeError'});
    await assert.rejects(inspect({execute:'SELECT'}), {name:'TypeError'});
  }
});

test('adoption readiness fails closed on a missing, duplicated or out-of-range rollout singleton', async ()=>{
  for(const rollout of [[], null, [{id:2, registrations_closed:0}], [{id:1, registrations_closed:0}, {id:2, registrations_closed:0}]]){
    const result=await inspectMembershipAdoptionReadiness(fakeDb({rollout}));
    assert.equal(result.ok, false);
    assert.equal(result.registrationState, 'invalid');
    assert.deepEqual(result.blockers, ['rollout_singleton_invalid']);
    assert.equal(result.counts.rolloutRows, rollout?.length ?? 0);
  }

  const outOfRange=await inspectMembershipAdoptionReadiness(fakeDb({rollout:[{id:1, registrations_closed:2}]}));
  assert.equal(outOfRange.registrationState, 'invalid');
  assert.deepEqual(outOfRange.blockers, ['rollout_value_invalid']);
});

test('an open rollout is ready only while no membership state exists', async ()=>{
  const pristine=await inspectMembershipAdoptionReadiness(fakeDb({
    rollout:[{id:1, registrations_closed:0}], primary:null, aggregate:{circles:0},
  }));
  assert.deepEqual(pristine, {
    ok:true, registrationState:'open', blockers:[],
    counts:{rolloutRows:1, activePrimaryCircles:0, circles:0, memberships:0, invitations:0, auditEvents:0, completedBackfills:0},
  });

  for(const key of ['circles', 'memberships', 'invitations', 'auditEvents']){
    const result=await inspectMembershipAdoptionReadiness(fakeDb({
      rollout:[{id:1, registrations_closed:0}], aggregate:{[key]:'3'},
    }));
    assert.deepEqual(result.blockers, ['open_rollout_has_membership_state'], key);
    assert.equal(result.counts[key], 3);
  }

  // Malformed aggregate values are clamped to zero rather than trusted.
  const malformed=await inspectMembershipAdoptionReadiness(fakeDb({
    rollout:[{id:1, registrations_closed:0}], aggregate:{circles:-4, memberships:'x', invitations:1.5},
  }));
  assert.equal(malformed.ok, true);
  assert.equal(malformed.counts.circles, 0);
  assert.equal(malformed.counts.memberships, 0);
  assert.equal(malformed.counts.invitations, 0);
});

test('a closed adoption rollout needs one valid primary circle and clean audit provenance', async ()=>{
  const closed={rollout:[{id:1, registrations_closed:1}], aggregate:{circles:1, memberships:2, completedBackfills:1}};
  const healthy=await inspectMembershipAdoptionReadiness(fakeDb({...closed, state:HEALTHY_ADOPTION_STATE}));
  assert.equal(healthy.ok, true, JSON.stringify(healthy.blockers));
  assert.equal(healthy.registrationState, 'closed');

  for(const primary of [[], [{id:7}, {id:8}], [{id:0}], [{id:'x'}]]){
    const db=fakeDb({...closed, primary, state:HEALTHY_ADOPTION_STATE});
    const result=await inspectMembershipAdoptionReadiness(db);
    assert.deepEqual(result.blockers, ['closed_rollout_primary_circle_invalid']);
    assert.equal(db.statements.length, 3, 'state query must not run without a valid primary circle');
  }

  const broken=await inspectMembershipAdoptionReadiness(fakeDb({
    ...closed,
    aggregate:{...closed.aggregate, completedBackfills:2},
    state:{activeOwners:0, matchingBackfills:1, invalidAccountProvenance:0, malformedBackfillAudits:0,
      malformedInvitationAudits:1, uncoveredAccounts:2, orphanMemberships:1},
  }));
  assert.deepEqual(broken.blockers, [
    'closed_rollout_has_no_owner',
    'closed_rollout_backfill_audit_invalid',
    'closed_rollout_account_audit_invalid',
    'closed_rollout_has_uncovered_accounts',
    'closed_rollout_has_orphan_memberships',
  ]);

  for(const key of ['invalidAccountProvenance', 'malformedBackfillAudits', 'malformedActivationAudits']){
    const result=await inspectMembershipAdoptionReadiness(fakeDb({...closed, state:{...HEALTHY_ADOPTION_STATE, [key]:1}}));
    assert.deepEqual(result.blockers, ['closed_rollout_account_audit_invalid'], key);
  }
  const unmatched=await inspectMembershipAdoptionReadiness(fakeDb({...closed, state:{...HEALTHY_ADOPTION_STATE, matchingBackfills:0}}));
  assert.deepEqual(unmatched.blockers, ['closed_rollout_backfill_audit_invalid']);

  // A missing state row is read as all-zero counts, which must fail closed (no owner, no backfill).
  const empty=await inspectMembershipAdoptionReadiness(fakeDb({...closed, state:null}));
  assert.equal(empty.ok, false);
  assert.ok(empty.blockers.includes('closed_rollout_has_no_owner'));
});

test('completed rollout readiness validates singleton, primary circle, creator and audit trail', async ()=>{
  const healthyDb=fakeDb({state:HEALTHY_COMPLETED_STATE});
  const healthy=await inspectCompletedMembershipRollout(healthyDb);
  assert.deepEqual(healthy, {ok:true, registrationState:'closed', blockers:[], counts:HEALTHY_COMPLETED_STATE});
  const stateQuery=healthyDb.statements.at(-1);
  assert.equal(stateQuery.args[0], 7);
  assert.equal(stateQuery.args[1], 3);
  assert.ok(stateQuery.args.includes('primary-membership-backfill:7:v1'));

  assert.deepEqual(await inspectCompletedMembershipRollout(fakeDb({rollout:null})), {
    ok:false, registrationState:'invalid', blockers:['rollout_singleton_invalid'],
  });
  assert.deepEqual(await inspectCompletedMembershipRollout(fakeDb({rollout:[{id:1, registrations_closed:0}]})), {
    ok:false, registrationState:'open', blockers:['rollout_not_completed'],
  });
  for(const primary of [null, [{id:7, created_by:3}, {id:8, created_by:3}], [{id:-1, created_by:3}]]){
    assert.deepEqual((await inspectCompletedMembershipRollout(fakeDb({primary}))).blockers, ['closed_rollout_primary_circle_invalid']);
  }
  for(const created_by of [null, 0, 'owner']){
    assert.deepEqual(
      (await inspectCompletedMembershipRollout(fakeDb({primary:[{id:7, created_by}]}))).blockers,
      ['closed_rollout_backfill_audit_invalid'],
    );
  }

  const failing=await inspectCompletedMembershipRollout(fakeDb({state:{
    ...HEALTHY_COMPLETED_STATE, activeOwners:0, malformedCompletionAudits:1, malformedBackfillAudits:2, orphanMemberships:1,
  }}));
  assert.deepEqual(failing.blockers, [
    'closed_rollout_has_no_owner',
    'closed_rollout_backfill_audit_invalid',
    'closed_rollout_account_audit_invalid',
    'closed_rollout_has_orphan_memberships',
  ]);
  for(const key of ['canonicalBackfillActors', 'completedBackfills', 'matchingBackfills']){
    const result=await inspectCompletedMembershipRollout(fakeDb({state:{...HEALTHY_COMPLETED_STATE, [key]:2}}));
    assert.deepEqual(result.blockers, ['closed_rollout_backfill_audit_invalid'], key);
  }
  for(const key of ['invalidAccountProvenance', 'malformedInvitationAudits', 'malformedActivationAudits']){
    const result=await inspectCompletedMembershipRollout(fakeDb({state:{...HEALTHY_COMPLETED_STATE, [key]:1}}));
    assert.deepEqual(result.blockers, ['closed_rollout_account_audit_invalid'], key);
  }
});

test('rollout readiness dispatches to steady-state only for a valid closed singleton', async ()=>{
  const completed=await inspectMembershipRolloutReadiness(fakeDb({state:HEALTHY_COMPLETED_STATE}));
  assert.equal(completed.ok, true);
  assert.ok('canonicalBackfillActors' in completed.counts);

  const open=await inspectMembershipRolloutReadiness(fakeDb({rollout:[{id:1, registrations_closed:0}], aggregate:{}}));
  assert.equal(open.registrationState, 'open');
  assert.equal(open.ok, true);

  const missing=await inspectMembershipRolloutReadiness(fakeDb({rollout:null}));
  assert.deepEqual(missing.blockers, ['rollout_singleton_invalid']);

  const wrongId=await inspectMembershipRolloutReadiness(fakeDb({rollout:[{id:2, registrations_closed:1}]}));
  assert.deepEqual(wrongId.blockers, ['rollout_singleton_invalid']);
});

test('activation provenance SQL keeps positional args aligned with and without the v7 activation ledger', async ()=>{
  const placeholders=sql=>(sql.match(/\?/g)||[]).length;
  const cases=[
    ['adoption', inspectMembershipAdoptionReadiness, {aggregate:{completedBackfills:1}, state:HEALTHY_ADOPTION_STATE}],
    ['completed', inspectCompletedMembershipRollout, {state:HEALTHY_COMPLETED_STATE}],
  ];
  for(const [name, inspect, options] of cases){
    for(const activationLedger of [[{present:1}], [{present:0}], [], null]){
      const db=fakeDb({...options, activationLedger});
      const result=await inspect(db);
      assert.equal(result.ok, true, `${name} ${JSON.stringify(activationLedger)}`);
      assert.equal(result.counts.malformedActivationAudits, 0);
      const probe=db.statements.find(statement=>String(statement.sql||statement).includes('FROM sqlite_schema'));
      assert.ok(probe, `${name} probes for the activation ledger`);
      const stateQuery=db.statements.at(-1);
      assert.equal(placeholders(stateQuery.sql), stateQuery.args.length, `${name} placeholder count`);
      const present=activationLedger?.[0]?.present===1;
      assert.equal(stateQuery.sql.includes('auth_email_activations'), present, name);
      assert.ok(stateQuery.sql.includes(`event.event_type='activation.verified'`), name);
      assert.ok(stateQuery.sql.includes('AS malformedActivationAudits'), name);
      // Every positional argument except the backfill dedupe key and creator is the primary circle.
      const nonPrimary=stateQuery.args.filter(arg=>arg!==7);
      assert.deepEqual(
        nonPrimary,
        name==='adoption'
          ? ['primary-membership-backfill:7:v1']
          : [3, 3, 'primary-membership-backfill:7:v1', 3, 'primary-membership-backfill:7:v1', 3, 3],
        name,
      );
    }
  }
});
