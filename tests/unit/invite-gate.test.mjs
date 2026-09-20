import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source=readFileSync(new URL('../../assets/invite-gate.js',import.meta.url),'utf8');

function loadGate(){
  const context=vm.createContext({});
  vm.runInContext(source,context,{filename:'assets/invite-gate.js'});
  return context._randori_invite_gate;
}

const BINDING_A='A'.repeat(43);
const BINDING_B='B'.repeat(43);

test('prepared invitation gate accepts only a bounded exact generation and binding',()=>{
  let now=100;
  const api=loadGate();
  const gate=api.create({now:()=>now});
  const first=gate.beginPreparation();
  const second=gate.beginPreparation();

  assert.equal(gate.completePreparation(first,{
    ok:true,expiresInSeconds:600,inviteBinding:BINDING_A,
  }),false,'an older prepare response cannot replace the current generation');
  assert.equal(gate.completePreparation(second,{
    ok:true,expiresInSeconds:600,inviteBinding:BINDING_B,
  }),true);
  const snapshot=gate.liveSnapshot();
  assert.deepEqual({...snapshot},{generation:second,deadline:600100,binding:BINDING_B});
  assert.equal(gate.matches(snapshot),true);
  assert.equal(gate.matches({...snapshot,binding:BINDING_A}),false);
});

test('prepared invitation gate fails closed for malformed or overlong lifetimes',()=>{
  const api=loadGate();
  assert.equal(api.MAX_PREPARED_INVITE_SECONDS,600);
  for(const expiresInSeconds of [null,0,-1,600.1,601,'600',Number.POSITIVE_INFINITY]){
    const gate=api.create({now:()=>0});
    const generation=gate.beginPreparation();
    assert.equal(gate.completePreparation(generation,{
      ok:true,expiresInSeconds,inviteBinding:BINDING_A,
    }),false);
    assert.equal(gate.liveSnapshot(),null);
  }
  const gate=api.create({now:()=>0});
  const generation=gate.beginPreparation();
  assert.equal(gate.completePreparation(generation,{
    ok:true,expiresInSeconds:600,inviteBinding:'not-canonical',
  }),false);
});

test('deadline is monotonic and expiration invalidates captured operations',()=>{
  let now=1_000;
  const gate=loadGate().create({now:()=>now});
  const generation=gate.beginPreparation();
  assert.equal(gate.completePreparation(generation,{
    ok:true,expiresInSeconds:1,inviteBinding:BINDING_A,
  }),true);
  const snapshot=gate.liveSnapshot();
  assert.equal(gate.remainingMilliseconds(snapshot),1_000);

  now=900;
  assert.equal(gate.remainingMilliseconds(snapshot),1_000,
    'a backwards clock adjustment cannot extend the deadline');
  now=2_000;
  assert.equal(gate.matches(snapshot),false);
  assert.equal(gate.expire(snapshot),true);
  assert.equal(gate.phase,'expired');
  assert.equal(gate.liveSnapshot(),null);
  assert.equal(gate.matches(snapshot),false);
});

test('network and parser time consume the advertised lifetime instead of extending it',()=>{
  let now=100;
  const gate=loadGate().create({now:()=>now});
  const generation=gate.beginPreparation();
  now=900;
  assert.equal(gate.completePreparation(generation,{
    ok:true,expiresInSeconds:1,inviteBinding:BINDING_A,
  }),true);
  const snapshot=gate.liveSnapshot();
  assert.equal(snapshot.deadline,1_100);
  assert.equal(gate.remainingMilliseconds(snapshot),200);

  now=1_100;
  assert.equal(gate.matches(snapshot),false);

  now=2_000;
  const delayed=gate.beginPreparation();
  now=3_001;
  assert.equal(gate.completePreparation(delayed,{
    ok:true,expiresInSeconds:1,inviteBinding:BINDING_B,
  }),false,'a response arriving after the advertised lifetime is already expired');
  assert.equal(gate.phase,'expired');
});

test('invalidation fences delayed completion and stale snapshots',()=>{
  let now=0;
  const gate=loadGate().create({now:()=>now});
  const generation=gate.beginPreparation();
  gate.invalidate('auth_changed');
  assert.equal(gate.completePreparation(generation,{
    ok:true,expiresInSeconds:60,inviteBinding:BINDING_A,
  }),false);

  const current=gate.beginPreparation();
  assert.equal(gate.completePreparation(current,{
    ok:true,expiresInSeconds:60,inviteBinding:BINDING_B,
  }),true);
  const snapshot=gate.liveSnapshot();
  gate.invalidate('completed');
  assert.equal(gate.matches(snapshot),false);
  assert.equal(gate.remainingMilliseconds(snapshot),0);
});
