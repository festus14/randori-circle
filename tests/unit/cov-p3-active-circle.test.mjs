import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  accountHasMultipleActiveCircles,
  canUseLegacySinglePrimaryCircleFeatures,
  listSessionCircleContexts,
  normalizeCirclePublicId,
  requestCircleContextVersion,
  requestMatchesCircleContext,
  resolveActiveCircleContext,
  selectActiveCircleContext,
  sendMultiCircleFeatureUnavailable,
  validateActiveCircleMutationContext,
} from '../../api/_active-circle.js';

const HASH='a'.repeat(64);
const PAYLOAD=Object.freeze({id:7,sessionHash:HASH});

function circleRow(overrides={}){
  return {circle_id:11,public_id:'circle-a',name:'Circle A',is_primary:1,role:'owner',...overrides};
}

// Scripted client: each execute() pops the next response (or calls it with the statement).
function scriptedDb(responses){
  const statements=[];
  const queue=[...responses];
  const run=async statement=>{
    statements.push(statement);
    const next=queue.shift();
    if(next instanceof Error) throw next;
    return typeof next==='function'?next(statement):(next||{rows:[]});
  };
  return {statements,execute:run};
}

function scriptedTransactionDb(responses,{commitError=null,rollbackError=null,closeError=null}={}){
  const inner=scriptedDb(responses);
  const log=[];
  return {
    log,statements:inner.statements,
    execute:inner.execute,
    async transaction(mode){
      log.push(`begin:${mode}`);
      return {
        execute:inner.execute,
        async commit(){ log.push('commit'); if(commitError) throw commitError; },
        async rollback(){ log.push('rollback'); if(rollbackError) throw rollbackError; },
        async close(){ log.push('close'); if(closeError) throw closeError; },
      };
    },
  };
}

test('public ids and context-version headers are strictly normalized',()=>{
  assert.equal(normalizeCirclePublicId(42),null);
  assert.equal(normalizeCirclePublicId('  circle_1-x  '),'circle_1-x');
  assert.equal(normalizeCirclePublicId('-leading'),null);
  assert.equal(normalizeCirclePublicId('x'.repeat(129)),null);

  assert.equal(requestCircleContextVersion({headers:{'x-randori-circle-context-version':'0'}}),0);
  assert.equal(requestCircleContextVersion({headers:{'x-randori-circle-context-version':'12'}}),12);
  for(const value of [['1'],'01','-1','1.5','',undefined]){
    assert.equal(requestCircleContextVersion({headers:{'x-randori-circle-context-version':value}}),null);
  }
  assert.equal(requestCircleContextVersion(undefined),null);
  // An unsafe integer header is syntactically valid but rejected by the version guard.
  assert.equal(requestCircleContextVersion({headers:{'x-randori-circle-context-version':'9'.repeat(20)}}),null);

  const req={headers:{'x-randori-circle-context-version':'3'}};
  assert.equal(requestMatchesCircleContext(req,{context_version:3}),true);
  assert.equal(requestMatchesCircleContext(req,{context_version:'3'}),true);
  assert.equal(requestMatchesCircleContext(req,{context_version:4}),false);
  assert.equal(requestMatchesCircleContext(req,null),false);
  assert.equal(requestMatchesCircleContext({headers:{}},{context_version:0}),false);
});

test('mutation-context validation rejects malformed identities before any query',async()=>{
  const db=scriptedDb([]);
  const bad=[
    [db,{id:7,sessionHash:'short'},{circleId:1,contextVersion:0}],
    [db,{id:0,sessionHash:HASH},{circleId:1,contextVersion:0}],
    [db,{uid:'07',sessionHash:HASH},{circleId:1,contextVersion:0}],
    [db,PAYLOAD,{circleId:'abc',contextVersion:0}],
    [db,PAYLOAD,{circleId:1,contextVersion:-1}],
    [db,PAYLOAD,{circleId:1,contextVersion:'01'}],
    [{},PAYLOAD,{circleId:1,contextVersion:0}],
    [null,PAYLOAD,{circleId:1,contextVersion:0}],
  ];
  for(const [client,payload,options] of bad){
    await assert.rejects(validateActiveCircleMutationContext(client,payload,options),TypeError);
  }
  await assert.rejects(validateActiveCircleMutationContext(db,PAYLOAD),TypeError);
  assert.equal(db.statements.length,0);
});

test('mutation-context validation binds explicit versions and implicit single-circle sessions',async()=>{
  const explicit=scriptedDb([{rows:[{circle_id:5}]}]);
  // The uid alias and string identifiers are accepted when canonical.
  assert.equal(await validateActiveCircleMutationContext(explicit,{uid:'7',sessionHash:HASH},
    {circleId:'5',contextVersion:'2'}),true);
  assert.deepEqual(explicit.statements[0].args,[HASH,7,5,2]);
  assert.match(explicit.statements[0].sql,/context\.context_version=\?/);

  const implicit=scriptedDb([{rows:[{circle_id:5}]}]);
  assert.equal(await validateActiveCircleMutationContext(implicit,PAYLOAD,
    {circleId:5,contextVersion:0,implicit:true}),true);
  assert.deepEqual(implicit.statements[0].args,[HASH,7,5]);
  assert.match(implicit.statements[0].sql,/NOT EXISTS/);

  // Zero or ambiguous matches both fail closed.
  assert.equal(await validateActiveCircleMutationContext(scriptedDb([{rows:[]}]),PAYLOAD,
    {circleId:5,contextVersion:0}),false);
  assert.equal(await validateActiveCircleMutationContext(scriptedDb([{rows:[{},{}]}]),PAYLOAD,
    {circleId:5,contextVersion:0}),false);
  assert.equal(await validateActiveCircleMutationContext(scriptedDb([{}]),PAYLOAD,
    {circleId:5,contextVersion:0}),false);
});

test('listing contexts selects stored, implicit, or no active circle and fails on corrupt rows',async()=>{
  await assert.rejects(listSessionCircleContexts(scriptedDb([]),{id:7}),TypeError);
  await assert.rejects(listSessionCircleContexts(null,PAYLOAD),TypeError);

  const none=await listSessionCircleContexts(scriptedDb([{},{}]),PAYLOAD);
  assert.deepEqual(none.circles,[]);
  assert.equal(none.active,null);
  assert.equal(none.selection_required,false);
  assert.equal(none.implicit,false);
  assert.equal(none.context_version,0);

  const implicit=await listSessionCircleContexts(scriptedDb([{rows:[circleRow()]},{rows:[]}]),PAYLOAD);
  assert.equal(implicit.implicit,true);
  assert.equal(implicit.active.public_id,'circle-a');
  assert.equal(implicit.active.is_primary,true);

  const two=[circleRow(),circleRow({circle_id:12,public_id:'circle-b',name:'  B  ',is_primary:0,role:'member'})];
  const unselected=await listSessionCircleContexts(scriptedDb([{rows:two},{rows:[]}]),PAYLOAD);
  assert.equal(unselected.active,null);
  assert.equal(unselected.selection_required,true);

  const selected=await listSessionCircleContexts(scriptedDb([{rows:two},{rows:[{circle_id:12,context_version:4}]}]),PAYLOAD);
  assert.equal(selected.active.id,12);
  assert.equal(selected.active.name,'B');
  assert.equal(selected.active.role,'member');
  assert.equal(selected.context_version,4);

  // A stored context naming a circle the account no longer belongs to is not active.
  const stale=await listSessionCircleContexts(scriptedDb([{rows:two},{rows:[{circle_id:99,context_version:4}]}]),PAYLOAD);
  assert.equal(stale.active,null);
  assert.equal(stale.selection_required,true);
  // A stored context with an unusable circle id is treated as no selection.
  const zero=await listSessionCircleContexts(scriptedDb([{rows:[circleRow()]},{rows:[{circle_id:0,context_version:1}]}]),PAYLOAD);
  assert.equal(zero.active,null);
  assert.equal(zero.implicit,false);

  const overLimit=Array.from({length:101},(_,index)=>circleRow({circle_id:index+1,public_id:`c${index}`}));
  await assert.rejects(listSessionCircleContexts(scriptedDb([{rows:overLimit},{rows:[]}]),PAYLOAD),/limit exceeded/);
  await assert.rejects(listSessionCircleContexts(scriptedDb([{rows:[circleRow()]},
    {rows:[{circle_id:11,context_version:1},{circle_id:11,context_version:2}]}]),PAYLOAD),/invalid active circle context/);
  await assert.rejects(listSessionCircleContexts(scriptedDb([{rows:[circleRow()]},
    {rows:[{circle_id:11,context_version:-3}]}]),PAYLOAD),/invalid active circle context/);
  for(const corrupt of [{role:'admin'},{public_id:'!bad'},{name:'   '},{circle_id:'x'}]){
    await assert.rejects(listSessionCircleContexts(scriptedDb([{rows:[circleRow(corrupt)]},{rows:[]}]),PAYLOAD),
      /invalid active circle membership/);
  }
});

test('resolving the active circle reports membership, selection, and role requirements',async()=>{
  const missing=await resolveActiveCircleContext(scriptedDb([{rows:[]},{rows:[]}]),PAYLOAD);
  assert.equal(missing.ok,false);
  assert.equal(missing.reason,'membership_required');
  const two=[circleRow(),circleRow({circle_id:12,public_id:'circle-b',role:'member'})];
  const unselected=await resolveActiveCircleContext(scriptedDb([{rows:two},{rows:[]}]),PAYLOAD);
  assert.equal(unselected.reason,'selection_required');
  const member=await resolveActiveCircleContext(scriptedDb([{rows:[circleRow({role:'member'})]},{rows:[]}]),
    PAYLOAD,{requiredRole:'owner'});
  assert.equal(member.ok,false);
  assert.equal(member.reason,'role_required');
  const owner=await resolveActiveCircleContext(scriptedDb([{rows:[circleRow()]},{rows:[]}]),PAYLOAD,{requiredRole:'owner'});
  assert.equal(owner.ok,true);
  assert.equal(owner.membership.id,11);
});

test('selection validates input, handles unavailable and changed contexts, and audits changes',async()=>{
  const invalid=[
    [scriptedTransactionDb([]),{id:7},{circlePublicId:'circle-a',expectedContextVersion:0}],
    [scriptedTransactionDb([]),PAYLOAD,{circlePublicId:'!',expectedContextVersion:0}],
    [scriptedTransactionDb([]),PAYLOAD,{circlePublicId:'circle-a',expectedContextVersion:'x'}],
    [scriptedTransactionDb([]),PAYLOAD,{circlePublicId:'circle-a',expectedContextVersion:0,nowSeconds:0}],
    [scriptedTransactionDb([]),PAYLOAD,{circlePublicId:'circle-a',expectedContextVersion:0,nowSeconds:1.5}],
    [{execute(){}},PAYLOAD,{circlePublicId:'circle-a',expectedContextVersion:0}],
  ];
  for(const [db,payload,options] of invalid){
    await assert.rejects(selectActiveCircleContext(db,payload,options),TypeError);
  }
  await assert.rejects(selectActiveCircleContext(scriptedTransactionDb([]),PAYLOAD),TypeError);

  const options={circlePublicId:'circle-a',expectedContextVersion:0,nowSeconds:1_700_000_000};
  const unavailable=scriptedTransactionDb([{rows:[]}],{rollbackError:new Error('ignored')});
  assert.deepEqual(await selectActiveCircleContext(unavailable,PAYLOAD,options),{ok:false,reason:'circle_unavailable'});
  assert.deepEqual(unavailable.log,['begin:write','rollback','close']);

  const changed=scriptedTransactionDb([{rows:[circleRow()]},{rows:[{circle_id:12,context_version:3}]}]);
  assert.deepEqual(await selectActiveCircleContext(changed,PAYLOAD,options),
    {ok:false,reason:'context_changed',context_version:3});

  const same=scriptedTransactionDb([{rows:[circleRow()]},{rows:[{circle_id:11,context_version:2}]}]);
  const unchanged=await selectActiveCircleContext(same,PAYLOAD,{...options,expectedContextVersion:2});
  assert.equal(unchanged.ok,true);
  assert.equal(unchanged.changed,false);
  assert.equal(unchanged.context_version,2);
  assert.deepEqual(same.log,['begin:write','commit','close']);

  // First selection inserts version 1 and writes one audit row.
  const first=scriptedTransactionDb([{rows:[circleRow()]},{rows:[]},
    {rows:[{circle_id:11,context_version:1}]},{rows:[{id:1}]}]);
  const inserted=await selectActiveCircleContext(first,PAYLOAD,options);
  assert.equal(inserted.changed,true);
  assert.equal(inserted.context_version,1);
  assert.match(first.statements[2].sql,/INSERT INTO auth_session_circle_contexts/);
  assert.match(first.statements[3].args[3],/^circle-context-selected:/);

  // Switching increments the version through a guarded UPDATE.
  const switching=scriptedTransactionDb([{rows:[circleRow()]},{rows:[{circle_id:12,context_version:5}]},
    {rows:[{circle_id:11,context_version:6}]},{rows:[{id:2}]}]);
  const updated=await selectActiveCircleContext(switching,PAYLOAD,{...options,expectedContextVersion:5});
  assert.equal(updated.context_version,6);
  assert.match(switching.statements[2].sql,/UPDATE auth_session_circle_contexts/);

  // A guarded write that loses the race rolls back as context_changed.
  for(const raced of [{rows:[]},{rows:[{circle_id:12,context_version:1}]},{rows:[{circle_id:11,context_version:9}]}]){
    const db=scriptedTransactionDb([{rows:[circleRow()]},{rows:[]},raced]);
    assert.deepEqual(await selectActiveCircleContext(db,PAYLOAD,options),{ok:false,reason:'context_changed'});
    assert.ok(db.log.includes('rollback'));
    assert.ok(!db.log.includes('commit'));
  }
});

test('selection fails closed and rolls back on corrupt context rows and missing audits',async()=>{
  const options={circlePublicId:'circle-a',expectedContextVersion:0,nowSeconds:1_700_000_000};
  const duplicate=scriptedTransactionDb([{rows:[circleRow()]},{rows:[{circle_id:1,context_version:0},{circle_id:2,context_version:0}]}]);
  await assert.rejects(selectActiveCircleContext(duplicate,PAYLOAD,options),/invalid active circle context/);
  assert.deepEqual(duplicate.log,['begin:write','rollback','close']);

  const negative=scriptedTransactionDb([{rows:[circleRow()]},{rows:[{circle_id:1,context_version:-1}]}]);
  await assert.rejects(selectActiveCircleContext(negative,PAYLOAD,options),/invalid active circle context/);

  const noAudit=scriptedTransactionDb([{rows:[circleRow()]},{},{rows:[{circle_id:11,context_version:1}]},{rows:[]}],
    {rollbackError:new Error('rollback ignored'),closeError:new Error('close ignored')});
  await assert.rejects(selectActiveCircleContext(noAudit,PAYLOAD,options),/audit unavailable/);
  assert.ok(noAudit.log.includes('rollback'));

  // A commit failure after the audit is surfaced but not double-rolled back.
  const commitFails=scriptedTransactionDb([{rows:[circleRow()]},{rows:[]},{rows:[{circle_id:11,context_version:1}]},
    {rows:[{id:3}]}],{commitError:new Error('commit failed')});
  await assert.rejects(selectActiveCircleContext(commitFails,PAYLOAD,options),/commit failed/);
  assert.deepEqual(commitFails.log,['begin:write','commit','rollback','close']);

  const corruptMembership=scriptedTransactionDb([{rows:[circleRow({role:'guest'})]}]);
  await assert.rejects(selectActiveCircleContext(corruptMembership,PAYLOAD,options),/invalid active circle membership/);
});

test('multi-circle and legacy-primary probes require exact single-primary evidence',async()=>{
  await assert.rejects(accountHasMultipleActiveCircles(scriptedDb([]),0),TypeError);
  await assert.rejects(accountHasMultipleActiveCircles(null,1),TypeError);
  assert.equal(await accountHasMultipleActiveCircles(scriptedDb([{rows:[{},{}]}]),'3'),true);
  assert.equal(await accountHasMultipleActiveCircles(scriptedDb([{rows:[{}]}]),3),false);
  assert.equal(await accountHasMultipleActiveCircles(scriptedDb([{}]),3),false);

  assert.equal(await canUseLegacySinglePrimaryCircleFeatures(null,PAYLOAD),false);
  assert.equal(await canUseLegacySinglePrimaryCircleFeatures(scriptedDb([]),{id:7}),false);
  assert.equal(await canUseLegacySinglePrimaryCircleFeatures(scriptedDb([{rows:[]}]),PAYLOAD),false);
  assert.equal(await canUseLegacySinglePrimaryCircleFeatures(scriptedDb([{rows:[{},{}]}]),PAYLOAD),false);
  const row=overrides=>({rows:[{active_circle_count:1,primary_circle_count:1,selected_circle_id:null,
    selected_circle_active:0,...overrides}]});
  assert.equal(await canUseLegacySinglePrimaryCircleFeatures(scriptedDb([row()]),PAYLOAD),true);
  assert.equal(await canUseLegacySinglePrimaryCircleFeatures(scriptedDb([row({selected_circle_id:4,selected_circle_active:1})]),PAYLOAD),true);
  assert.equal(await canUseLegacySinglePrimaryCircleFeatures(scriptedDb([row({selected_circle_id:4,selected_circle_active:0})]),PAYLOAD),false);
  assert.equal(await canUseLegacySinglePrimaryCircleFeatures(scriptedDb([row({primary_circle_count:0})]),PAYLOAD),false);
  assert.equal(await canUseLegacySinglePrimaryCircleFeatures(scriptedDb([row({active_circle_count:2})]),PAYLOAD),false);
});

test('multi-circle feature refusal uses a stable 409 contract',()=>{
  const sent={};
  const res={status(code){ sent.status=code; return this; },json(body){ sent.body=body; return this; }};
  sendMultiCircleFeatureUnavailable(res);
  assert.equal(sent.status,409);
  assert.equal(sent.body.code,'circle_feature_unavailable');
});
